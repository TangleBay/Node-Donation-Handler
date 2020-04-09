const request = require('request')
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors');
const paymentModule = require('iota-payment')
const sha256 = require('js-sha256');

const low = require('lowdb')
const FileAsync = require('lowdb/adapters/FileAsync')
const fetch = require('node-fetch');

const { PROVIDER, URL, APP_PORT, IOTAADDRESS } = require('./config.json');

const Mam = require('@iota/mam');

const { asciiToTrytes } = require('@iota/converter')
let {isValidChecksum} = require('@iota/checksum');
const generateSeed = require('iota-generate-seed');

let mamState;

const PORT = APP_PORT || 3000

// Create server
const app = express()
app.use(cors());
app.use(bodyParser.json())


let options = {
    api: true,
    websockets: true
}

let server = paymentModule.createServer(app, options)

//Create an event handler which is called, when a payment was successfull
let onPaymentSuccess = function (payment) {
    console.log(`Payment received:`, payment);
    handleDonation(payment)
    // .then((response) => {
    //     db.set('config.state', response.state)
    //         .write()

    //     db.get('snapshots')
    //         .push(response.snapshot)
    //         .last()
    //         .assign({ id: Date.now().toString() })
    //         .write()
    // })


}

// Listen to the "paymentSuccess" event and call function
paymentModule.onEvent('paymentSuccess', onPaymentSuccess);

// Create database instance and start server
const adapter = new FileAsync('db.json')
low(adapter)
    .then(db => {
        // Routes
        // GET /snapshots/:id
        app.get('/snapshots/:id', (req, res) => {
            const post = db.get('snapshots')
                .find({ id: req.params.id })
                .value()

            res.send(post)
        })

        // GET /root
        app.get('/', (req, res) => {
            const root = db.get('config.root')
                .value()
            res.send(root)
        })

         // GET /snapshots
         app.get('/snapshots', (req, res) => {
            const posts = db.get('snapshots')
                .value()
            res.send(posts)
        })

           // GET /payments
        app.get('/payments', (req, res) => {
            paymentModule.getPayments().then(payments => {
                    res.send(payments)
                })
                .catch(err => {
                    console.log(err)
                })
        })

           // GET /payouts/:nodeId
        app.get('/payouts/:nodeId', (req, res) => {
            let nodeId =  req.params.nodeId
            paymentModule.getPayouts().then(payouts => {
                    payouts = payouts.filter(p => typeof p.data != 'undefined')
                    payouts = payouts.filter(payout => payout.data.nodeId == nodeId).reverse();
                    res.send(payouts)
                })
                .catch(err => {
                    console.log(err)
                })
        })

        // GET /balance
        app.get('/balance', (req, res) => {
         paymentModule.getBalance().then(balance => {
                 res.send(balance)
             })
             .catch(err => {
                 console.log(err)
             })
        })

        // Initialise MAM State
        let seed = db.get('config.seed').value()
        console.log("seed", seed)
        if (seed) {
            mamState = Mam.init(PROVIDER, seed)

            let old_state = db.get('config.state').value()
            if (old_state) {
                updateMamState(old_state);
            }


        } else {
            seed = generateSeed()
            db.set('config.seed', seed)
                .write()

            mamState = Mam.init(PROVIDER, seed)

            db.set('config.root', Mam.getRoot(mamState))
                .write()
        }
        // Set db default values
        return db.defaults({ snapshots: [], config: {} }).write()
    })
    .then(() => {
        server.listen(PORT, () => console.log('Server listening on port ' + PORT))
    })

const fetchData = async () => {

    let response = await fetch(URL);
    let json = await response.json();
    return json
}

const updateMamState = newMamState => (mamState = newMamState);

// Publish to tangle
const publishToMAM = async data => {

    // Create MAM Payload - STRING OF TRYTES
    const trytes = asciiToTrytes(JSON.stringify(data))

    const message = Mam.create(mamState, trytes)

    // Save new mamState
    updateMamState(message.state);

    // Attach the payload
    let x = await Mam.attach(message.payload, message.address, 3, 14)

    return message
}

const handleDonation = async (payment) => {
    try{
    let data
    while(typeof data == 'undefined'){
        try{
            console.log("fetchData");
            data = await fetchData()
        }catch(e){}
        await new Promise(resolve => setTimeout(resolve, 20000))
    }

    console.log("nodes count", data.length)

    // make payout

    //check if own address is valid
    if(validAddress(IOTAADDRESS)){
        //set address for invalid entries
        data.map(e=> {
            if(!validAddress(e.address)){
            e.address = IOTAADDRESS
            e.key = 'Invalid'
            }
        })
    }

    // 1. get node_with_addresses
    const all_nodes_with_addresses = data.filter((node) => validAddress(node.address));

    //trim spaces
    for(node of all_nodes_with_addresses){
        node.address = node.address.trim()
    }

    console.log("all_nodes_with_addresses count", all_nodes_with_addresses.length)

    //remove spent addresses
    let addresses = all_nodes_with_addresses.map(e => e.address.slice(0, 81))
    let spentStatus = await wereAddressesSpentFrom(addresses)
    let nodes_with_addresses
    if(validAddress(IOTAADDRESS)){
        nodes_with_addresses = all_nodes_with_addresses.map((obj, index)=>{
            if(spentStatus[index] == true){
                obj.address = IOTAADDRESS
                obj.key = 'Spent'
            }
        })
    }else{
        nodes_with_addresses = all_nodes_with_addresses.filter((obj, index) => spentStatus[index] == false)
    }

    // 2. calculate shares
    let total_iotas = payment.txInfo.value
    let total_points = 0;

    //calculate total points
    nodes_with_addresses.forEach(function (object) {
        total_points = object.points + total_points;
    })

    //calculate shares, assign rounded iota value and calculate remaining iotas
    let assigned_iotas = 0
    nodes_with_addresses.forEach(function (object) {
        object.share = object.points / total_points
        object.iotas = Math.floor(total_iotas * object.share)
        assigned_iotas = object.iotas + assigned_iotas;
    })
    let remaining = total_iotas - assigned_iotas
    console.log(assigned_iotas);
    console.log(remaining);

    //sort by value, highest first
    nodes_with_addresses.sort((a, b) => b.iotas - a.iotas)

    //distribute remaining iotas and calculate total amount
    let calculated_total_iotas = 0
    nodes_with_addresses.map((e, index) => {
        index < remaining ? e.iotas += 1 : e.iotas
        calculated_total_iotas = e.iotas + calculated_total_iotas;
    })

    console.log(calculated_total_iotas);
    if (total_iotas != calculated_total_iotas) {
        throw "Assigned iota amount doesn't match total_iotas"
    }

    console.log(nodes_with_addresses);

    //send payouts
    let tag = 'POOL9PAYOUT'
    for(node of nodes_with_addresses){
        try {
            if(node.iotas>0){
                let payout = await paymentModule.sendPayout({
                    address: node.address,
                    value: node.iotas,
                    message: `einfachIOTA Pool donation payout!\nThe Fullnode "${node.name}" (ID: ${node.key}) with this donation address has ${node.points} points which is ${Math.floor((node.share*100) * 1000) / 1000}% of ${total_points} points.`,
                    tag,
                    data:{nodeId:node.key}
                })
                console.log(`Payout with ${payout.value} created for node (${node.key}). Address: ${payout.address}`);
                //wait 1 second
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (e) {
            console.log(e)
        }
    }

    // return {}
    // // Hash data
    // const hash = sha256(JSON.stringify(data))

    // let mam_message = {
    //     timestamp: Date.now(),
    //     data_hash: hash
    // }
    // let mam = await publishToMAM(mam_message)
    // let snapshot = {
    //     ...mam_message,
    //     root: mam.root
    // }

    // return { snapshot: snapshot, state: mam.state }
    } catch(err){
        console.error("Error in handleDonation", err);
    }
}

function wereAddressesSpentFrom(addresses, provider) {
    return new Promise(async (resolve, reject) => {
        try {
            var command = {
                command: 'wereAddressesSpentFrom',
                addresses: addresses
            }

            var options = {
                url: PROVIDER,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-IOTA-API-Version': '1',
                    'Content-Length': Buffer.byteLength(JSON.stringify(command))
                },
                json: command
            }

            request(options, function (error, response, data) {
                if (!error && response.statusCode == 200) {
                    resolve(data.states)
                }
            })
        } catch (e) {
            reject(e)
        }
    })
}

function validAddress(address){

    if (typeof address == 'string') {
        address = address.trim()
    } else {
        return false
    }

    try {
        if (!isValidChecksum(address)) {
          return false
        }
      } catch (e) {
        console.error(e)
        return false
      }

      //check last trit for Kerl address if value transfer
      if (!/[E-V]/.test(address.slice(80, 81))) {
        return true
      } else {
        return false
      }
}
