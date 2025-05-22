import { vad } from './vad/index.js';
import { base64ToArrBuff, queueSound, stopPlaying } from './utils.js';
import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

const resultsContainer = document.getElementById('recognition-result');
const partialContainer = document.getElementById('partial');
const socket = new WebSocket(`${location.protocol == 'https:' ? 'wss' : 'ws'}://${location.host}/websocket`);

socket.addEventListener('message', async (event) => {
	const data = JSON.parse(event.data);
	switch (data.type) {
		case 'audio':
			printSpeach(data.text, 'output');
			queueSound(data.audio);
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
	function onAudioBuffer(buff) {
		stopPlaying();
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
