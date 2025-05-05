import { moonshot } from './moonshot/index.js';
import { wav2AudioBuff } from './utils.js';
import * as tts from 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.4/+esm';
import asyncIterator from 'https://cdn.jsdelivr.net/npm/@cokoghenun/async-iterator@1.0.3/+esm';

const socket = new WebSocket('ws://localhost:8787/websocket');
// Connection opened
socket.addEventListener('open', (event) => {
	// socket.send('Hello Server!');
});

let source;
let audioCtx;
let channels = 2;
const sounds = [];
let isCurrentSoundDonePlaying = true;

function newSoundQueued() {
	if (isCurrentSoundDonePlaying) {
		isCurrentSoundDonePlaying = false;
		wav2AudioBuff(sounds.shift(), (audioBuffer) => {
			source = audioCtx.createBufferSource();
			source.buffer = audioBuffer;
			source.connect(audioCtx.destination);
			source.start();

			source.onended = () => {
				console.log('done playing');
				isCurrentSoundDonePlaying = true;
			};
		});
	} else {
		setTimeout(newSoundQueued, 1000);
	}
}

async function textToSound(text) {
	console.log(text);
	const sound = await tts.predict({
		text: text,
		voiceId: 'en_GB-cori-medium',
		// voiceId: 'en_US-hfc_female-medium',
	});

	// console.log(await tts.stored());
	// console.log(await tts.voices());

	console.log('sound processed');
	sounds.push(sound);
	newSoundQueued();
	isDoneProcessingForemostText = true;
}
const textQueue = [];
let isDoneProcessingForemostText = true;
async function processTextQueue() {
	if (isDoneProcessingForemostText) {
		isDoneProcessingForemostText = false;
		await textToSound(textQueue.shift());
	} else {
		setTimeout(processTextQueue, 1000);
	}
}
socket.addEventListener('message', async (event) => {
	const data = JSON.parse(event.data);
	switch (data.type) {
		case 'audio':
			audio.src = 'data:audio/wav;base64,' + LZString.decompress(data.audio);
			audio.play();
			break;
		case 'text':
			// const sentences = data.text.replace(/[\n\r\t]/gm, '').match(/\(?[^\.\?\!]+[\.!\?]\)?/g);
			// await sentencesToSound(sentences);
			// await sentencesToSound([data.text]);
			textQueue.push(data.text);
			await processTextQueue();

			break;
		default:
			break;
	}
});

async function init() {
	audioCtx = new AudioContext();
	const resultsContainer = document.getElementById('recognition-result');
	const partialContainer = document.getElementById('partial');

	function onTranscription(msg) {
		const newSpan = document.createElement('div');
		newSpan.textContent = `${msg} `;
		resultsContainer.insertBefore(newSpan, partialContainer);
		socket.send(msg);
	}
	function onStatus(msg) {
		partialContainer.textContent = msg;
	}
	moonshot(onStatus, onTranscription);
}

window.init = init;
// window.onload = init;
