import { moonshot } from './moonshot/index.js';
import { base64ToArrBuff } from './utils.js';

import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';
const socket = new WebSocket('ws://localhost:8787/websocket');

socket.addEventListener('open', (event) => {
	// socket.send('Hello Server!');
});

const sounds = [];
let isSpeaking = false;
const audioCtx = new AudioContext();
function speakNextSound() {
	if (!isSpeaking) {
		isSpeaking = true;
		const arrayBuff = base64ToArrBuff(sounds);
		arraybufferToAudiobuffer(arrayBuff, audioCtx).then((audioBuffer) => {
			const source = audioCtx.createBufferSource();
			source.buffer = audioBuffer;
			source.connect(audioCtx.destination);
			source.start();
			source.onended = () => {
				isSpeaking = false;
				console.log('done speaking');
			};
		});
	} else {
		setTimeout(speakNextSound, 1000);
	}
}
socket.addEventListener('message', async (event) => {
	const data = JSON.parse(event.data);
	switch (data.type) {
		case 'audio':
			console.log(data.text);
			sounds.push(data.audio);
			speakNextSound();
			break;
		case 'text':
			console.log(data.text);
			break;
		default:
			break;
	}
});

async function init() {
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
