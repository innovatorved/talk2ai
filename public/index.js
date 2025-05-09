import { moonshot } from './local-tts/index.js';
import { vosk } from './local-tts2/index.js';
import { base64ToArrBuff } from './utils.js';
import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

const resultsContainer = document.getElementById('recognition-result');
const partialContainer = document.getElementById('partial');
const socket = new WebSocket(`${location.protocol == 'https:' ? 'wss' : 'ws'}://${location.host}/websocket`);
const sounds = [];
let audioCtx;

let isSpeaking = false;

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
			sounds.push(data.audio);
			printSpeach(data.text, 'output');
			speakNextSound();
			break;
		default:
			break;
	}
});
function printSpeach(msg, type = 'input') {
	const newSpan = document.createElement('div');
	switch (type) {
		case 'output':
			newSpan.textContent = `<< ${msg} `;
			break;
		default:
			newSpan.textContent = `>> ${msg} `;
			break;
	}
	resultsContainer.insertBefore(newSpan, partialContainer);
}

async function init() {
	audioCtx = new AudioContext();
	function onTranscription(msg) {
		printSpeach(msg);
		socket.send(msg);
	}
	function onStatus(msg) {
		partialContainer.textContent = `[${msg}]`;
	}

	const isFirefox = navigator.userAgent.indexOf('Firefox') !== -1;
	if (isFirefox) return vosk(onTranscription, onStatus);
	moonshot(onTranscription, onStatus);
}

window.init = init;
