// importing the dependencies
const express = require('express');
const dotenv = require('dotenv');

//Setup env vars
dotenv.config();

const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const https = require('https');
const {startDatabase} = require('./database/mongo');
const {insertDelegateTx, insertVoteTx , getTxs, delegationAllowed, voteAllowed} = require('./database/awaitingTxs');
const Web3 = require('web3');
const fs = require('fs');
const axios = require('axios');
const web3 = new Web3(process.env.WEB3_URL);
const sigRelayerAbi = JSON.parse(fs.readFileSync('contracts/compiled/SigRelayer.abi'));
const compAbi = JSON.parse(fs.readFileSync('contracts/compiled/comp.abi'));
const governanceAlphaAbi = JSON.parse(fs.readFileSync('contracts/compiled/GovernorAlpha.abi'));
const sigRelayer = new web3.eth.Contract(sigRelayerAbi,'0xf61d8eef3f479dfa24beaa46bf6f235e6e2f7af8');
const compToken = new web3.eth.Contract(compAbi,'0xc00e94cb662c3520282e6f5717214004a7f26888');
const governanceAlpha = new web3.eth.Contract(governanceAlphaAbi,'0xc0da01a04c3f3e0be433606045bb7017a7323e38');
const inBeta = true;
const betaTesters = ['0x2b384212edc04ae8bb41738d05ba20e33277bf33','0xf3175c969a7fff999d7c711649dcb8770c15b12a','0xac5720d6ee2d7872b88914c9c5fa9bf38e72faf6','0x54a37d93e57c5da659f508069cf65a381b61e189','0x879d430d8eba1de4cf1bad4e20da5e559c030f11','0xe3c9ece23316b6b06142fa0ca915f02c323c6b21','0x7f89077b122afaaf6ab50aa12e9cb46bb9a058c4','0xb0325dbe7fa891436e83a094f9f12848c78e449b','0x18c8f1222083997405f2e482338a4650ac02e1d6','0x8d07d225a769b7af3a923481e1fdf49180e6a265','0xc3aae58ab81663872dd36d73613eb295b167f546','0xfc04833ca66b7d6b4f540d4c2544228f64a25ac2','0x7e4a8391c728fed9069b2962699ab416628b19fa'];



// defining the Express app
const app = express();
const testing = false;

// adding Helmet to enhance your API's security
app.use(helmet());

// using bodyParser to parse JSON bodies into JS objects
app.use(bodyParser.json());

// enabling CORS for all requests
app.use(cors());

// adding morgan to log HTTP requests
app.use(morgan('combined'));

// defining an endpoint to return all ads
app.get('/', async (req, res) => {
  res.send("A message to tennis: you snooze, you lose. For everyone else: Welcome to comp.vote! Instructions on how to use the API will be at comp.vote/api eventually. Until then message Arr00 on discord for instructions 😊");
});


app.get('/canDelegate', async(req, res) => {
	const fromAddress = req.query.address.toString().toLowerCase();

	if(fromAddress === undefined) {
		await res.status(400).send({message: 'invalid input'});
	}
	try {
			compBalance = await compToken.methods.balanceOf(fromAddress).call();
		}
	catch {
		await res.status(400).send({message: 'error fetching comp balance'});
		return;
	}

	if(compBalance < 1e18) {
		await res.status(400).send({message: 'must have balance of at least 1 COMP to delegate for free'});
		return;
	}

	try {
		currentDelegate = await compToken.methods.delegates(fromAddress).call();
	}
	catch {
		await res.status(400).send({message: 'error fetching delegate'});
		return;
	}
	if(inBeta && !betaTesters.includes(fromAddress.toLowerCase())) {
		await res.status(400).send({message: 'Only beta testers now. Request to be a beta tester on the Compound discord'});
		return;
	}
	try {
		await delegationAllowed(fromAddress);
	}
	catch(err) {
		await res.status(400).send({message: err.message});
		return;
	}

	res.status(200).send({message: 'delegation allowed'});
});

app.get('/canVote', async(req, res) => {
	const fromAddress = req.query.address.toString().toLowerCase();
	const proposalId = req.query.proposalId;

	if(fromAddress === undefined || proposalId === undefined) {
		await res.status(400).send({message: 'invalid input'});
	}

	let votesDelegated;
	let hasVoted;
	let startBlock;
	let endBlock;
	let canceled;
	let currentBlock;
	try {
		const proposal = await governanceAlpha.methods.proposals(proposalId).call();
		if(proposal.id.toString().toLowerCase().localeCompare(proposalId.toString().toLowerCase()) != 0) {
			throw new Error({message: 'invalid proposalId'});
		}
		startBlock = proposal.startBlock;
		endBlock = proposal.endBlock;
		cancelled = proposal.canceled;
		votesDelegated = await compToken.methods.getPriorVotes(fromAddress,proposal.startBlock).call();
		const receipt = await governanceAlpha.methods.getReceipt(proposalId,fromAddress).call();
		hasVoted = receipt.hasVoted
		currentBlock = await web3.eth.getBlockNumber();
	}
	catch {
		await res.status(400).send({message: 'voting by signature is not available for this proposal'});
		return;
	}


	if(votesDelegated < 1e18 && !testing) {
		await res.status(400).send({message: 'must have at least 1 COMP delegated to vote for free'});
		return;
	}
	else if(!(currentBlock > startBlock && currentBlock < (endBlock-5)) || canceled) {
		await res.status(400).send({message: 'voting by signature is not available for this proposal'});
		return;
	}
	else if(hasVoted) {
		await res.status(400).send({message: 'already voted for this proposal'});
		return;
	}
	if(inBeta && !betaTesters.includes(fromAddress.toLowerCase())) {
		await res.status(400).send({message: 'Only beta testers now. Request to be a beta tester on the Compound discord'});
		return;
	}
	try {
		await voteAllowed(fromAddress,proposalId);
	}
	catch(err) {
		await res.status(400).send({message: err.message});
		return;
	}

	res.status(200).send({message: 'voting allowed'});
});


app.post('/delegate', async (req, res) => {
	const newTx = req.body;
	console.log('Tx data is :');
	console.log(newTx);
	const delegatee = newTx.delegatee;
	const nonce = newTx.nonce;
	const expiry = newTx.expiry;
	const v = newTx.v;
	const r = newTx.r;
	const s = newTx.s;

	if(delegatee === undefined || nonce === undefined || expiry === undefined || v === undefined || r === undefined || s === undefined) {
		await res.status(400).send({
			message: 'Invalid input'
		});
		return;
	}

	else {
		let fromAddress
		try {
			fromAddress = (await sigRelayer.methods.signatoryFromDelegateSig(delegatee, nonce, expiry, v, r, s).call()).toString().toLowerCase();
		}
		catch {
			await res.status(400).send({message: 'invalid signature'});
			console.log('invalid sig');
			return;
		}

		let compBalance;
		let requiredNonce;
		let currentDelegate;

		try {
			requiredNonce = await compToken.methods.nonces(fromAddress).call();
		}
		catch {
			await res.status(400).send({message: 'error fetching acccount nonce'});
			return;
		}

		if(requiredNonce != nonce) {
			await res.status(400).send({message: 'required nonce is ' + requiredNonce});
			return;
		}

		try {
			compBalance = await compToken.methods.balanceOf(fromAddress).call();
		}
		catch {
			await res.status(400).send({message: 'error fetching comp balance'});
			return;
		}

		if(compBalance < 1e18 && !testing) {
			await res.status(400).send({message: 'must have balance of at least 1 COMP to delegate for free'});
			return;
		}

		try {
			currentDelegate = await compToken.methods.delegates(fromAddress).call();
		}
		catch {
			await res.status(400).send({message: 'error fetching delegate'});
			return;
		}
		if(currentDelegate.toString().toLowerCase().localeCompare(delegatee.toString().toLowerCase()) == 0 && !testing) {
			await res.status(400).send({message: 'already delegating to given address'});
			return;
		}
		if(inBeta && !betaTesters.includes(fromAddress.toLowerCase())) {
			await res.status(400).send({message: 'Only beta testers now. Request to be a beta tester on the Compound discord'});
			return;
		}

		else {
			console.log('Good to go');
			newTx.from = fromAddress;
			newTx.type = 'delegate';
			newTx.createdAt = new Date();
			newTx.executed = false;
			try {
				const txId = await insertDelegateTx(newTx);
			}
			catch(err) {
				console.log('err is ' + err.message);
				await res.status(400).send({message: err.message});
				return;
			}
			axios.get(process.env.NOTIFICATION_HOOK + 'New comp.vote delegation sig')
			await res.status(200).send({message: 'transaction queued'});
			return;
		}
	}
});

app.post('/vote', async (req, res) => {
	const newTx = req.body;
	const proposalId = newTx.proposalId;
	const support = newTx.support;
	const v = newTx.v;
	const r = newTx.r;
	const s = newTx.s;
	let go = true;


	if(proposalId === undefined || support === undefined || v === undefined || r === undefined || s === undefined) {
		res.status(400).send({
			message: 'Invalid input'
		});
	}

	else {
		let fromAddress;
		try {
			console.log('Input: ' + proposalId + ' ' + support + ' ' + v + ' ' + r + ' ' + s);
			fromAddress = (await sigRelayer.methods.signatoryFromVoteSig(proposalId, support, v, r, s).call()).toString().toLowerCase();;
			console.log('Response: ' + fromAddress);
		}
		catch {
			await res.status(400).send({message: 'invalid signature'});
			return;
		}

		let votesDelegated;
		let hasVoted;
		let startBlock;
		let endBlock;
		let canceled;
		let currentBlock;
		try {
			const proposal = await governanceAlpha.methods.proposals(proposalId).call();
			startBlock = proposal.startBlock;
			endBlock = proposal.endBlock;
			cancelled = proposal.canceled;
			votesDelegated = await compToken.methods.getPriorVotes(fromAddress,proposal.startBlock).call();
			const receipt = await governanceAlpha.methods.getReceipt(proposalId,fromAddress).call();
			hasVoted = receipt.hasVoted;
			currentBlock = await web3.eth.getBlockNumber();
		}
		catch {
			await res.status(400).send({message: 'voting by signature is not available for this proposal'});
			return;
		}

		if(votesDelegated < 1e18 && !testing) {
			await res.status(400).send({message: 'must have at least 1 COMP delegated to vote for free'});
			return;
		}

		else if(hasVoted) {
			await res.status(400).send({message: 'already voted for this proposal'});
			return;
		}
		else if(!(currentBlock > startBlock && currentBlock < (endBlock-5)) || canceled) {
			await res.status(400).send({message: 'voting by signature is not available for this proposal'});
			return;
		}

		if(inBeta && !betaTesters.includes(fromAddress.toLowerCase())) {
			await res.status(400).send({message: 'Only beta testers now. Request to be a beta tester on the Compound discord'});
			return;
		}

		else {
			console.log(fromAddress + ' is from');
			newTx.from = fromAddress;
			newTx.type = 'vote';
			newTx.createdAt = new Date();
			newTx.executed = false;
			try {
				const txId = await insertVoteTx(newTx);
			}
			catch(err) {
				console.log('err is ' + err.message);
				await res.status(400).send({message: err.message});
				return;
			}
			axios.get(process.env.NOTIFICATION_HOOK + 'New comp.vote voting sig');
			await res.status(200).send({message: 'transaction queued'});
			return
		}
	}
});

const httpsServer = https.createServer({
	key: fs.readFileSync('https/private.key'),
	cert: fs.readFileSync('https/certificate.crt')
}, app);


// start the in-memory MongoDB instance
startDatabase().then(async () => {
  // start the server
  httpsServer.listen(443, async () => {
    console.log('https listening on port 443');
  });
});



