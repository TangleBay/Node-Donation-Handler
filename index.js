const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors');
const paymentModule = require('iota-payment')
const sha256 = require('js-sha256');

const low = require('lowdb')
const FileAsync = require('lowdb/adapters/FileAsync')
const fetch = require('node-fetch');

const { PROVIDER, URL, APP_PORT } = require('./config.json');

const Mam = require('@iota/mam');

const { asciiToTrytes } = require('@iota/converter')
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
    handleDonation(payment).then((response) => {
        db.set('config.state', response.state)
            .write()

        db.get('snapshots')
            .push(response.snapshot)
            .last()
            .assign({ id: Date.now().toString() })
            .write()
    })


}

// Listen to the "paymentSuccess" event and call function
paymentModule.on('paymentSuccess', onPaymentSuccess);

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

        // GET /snapshots
        app.get('/snapshots', (req, res) => {
            const posts = db.get('snapshots')
                .value()
            res.send(posts)
        })


        // GET /root
        app.get('/', (req, res) => {
            const root = db.get('config.root')
                .value()
            res.send(root)
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
    let x = await Mam.attach(message.payload, message.address, 3, 9)

    return message
}

const handleDonation = async (payment) => {
    let data = await fetchData()

    console.log("nodes data", data)
    
    // TODO
    // TODO
    // TODO
    
    // make payout

    // 1. get Addresses
    // 2. calculate shares
    // 3. create bundle
    // 4. payout to all addresses

    // /TODO
    // /TODO
    // /TODO

    // Hash data
    const hash = sha256(JSON.stringify(data))

    let mam_message = {
        timestamp: Date.now(),
        data_hash: hash
    }
    let mam = await publishToMAM(mam_message)
    let snapshot = {
        ...mam_message,
        root: mam.root
    }

    return { snapshot: snapshot, state: mam.state }
}