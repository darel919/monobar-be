import express from "express";
const router = express.Router();

// TEAPOT
router.get('/', async(req,res) => {
    res.sendStatus(418)
})

// PING TEST
router.get('/ping', async (req, res) => {
    console.log(`Ping from ${req.headers['x-real-ip']}`)
    res.status(200).send("pong")
})

// DECIDE IF LOCAL OR VIA INTERNET
router.post('/ping', async (req, res) => {
    const response = {
        callingFrom: req.headers.origin,
        viaNginxProxy: req.headers['x-nginx-proxy'] || null,
    };
    
    console.log(response);
    res.send(response);
})



export default router;