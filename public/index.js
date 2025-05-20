import { vad } from './vad/index.js';
import { base64ToArrBuff } from './utils.js';
import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

const resultsContainer = document.getElementById('recognition-result');
const partialContainer = document.getElementById('partial');
const socket = new WebSocket(`${location.protocol == 'https:' ? 'wss' : 'ws'}://${location.host}/websocket`);

const sounds = [];
let audioCtx;

let isSpeaking = false;
let timeOutId;
let source;
let activeSources = [];
function speakNextSound() {
	if (!isSpeaking && sounds.length > 0) {
		isSpeaking = true;
		const arrayBuff = base64ToArrBuff(sounds.shift());
		arraybufferToAudiobuffer(arrayBuff, audioCtx).then((audioBuffer) => {
			source = audioCtx.createBufferSource();
			source.buffer = audioBuffer;
			source.connect(audioCtx.destination);
			source.start();
			activeSources.push(source);
			source.onended = () => {
				isSpeaking = false;
				console.log('done speaking');
			};
		});
	} else {
		timeOutId = setTimeout(speakNextSound, 1000);
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
		case 'text':
			printSpeach(data.text);
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
	function onAudioBuffer(buff) {
		activeSources.forEach((source) => {
			try {
				source.stop();
			} catch (e) {
				console.error('Error stopping source:', e);
			}
		});
		sounds.splice(0, sounds.length);
		if (timeOutId) clearTimeout(timeOutId);
		socket.send(buff);
	}
	function onStatus(msg) {
		partialContainer.textContent = `[${msg}]`;
	}

	const isFirefox = navigator.userAgent.indexOf('Firefox') !== -1;
	if (isFirefox)
		return alert(
			'Firefox not currently supported due to a known bug in Firefox. Please try again in another browser. \n\nhttps://bugzilla.mozilla.org/show_bug.cgi?id=1674892',
		);
	vad(onAudioBuffer, onStatus);
}

window.init = init;
