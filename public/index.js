import { moonshot } from './local-tts/index.js';
import { base64ToArrBuff } from './utils.js';
import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

const resultsContainer = document.getElementById('recognition-result');
const partialContainer = document.getElementById('partial');
const socket = new WebSocket(`ws://${window.location.host}/websocket`);
const sounds = [];
const audioCtx = new AudioContext();

let recognition;
let isSpeaking = false;

function speakNextSound() {
	if (!isSpeaking) {
		isSpeaking = true;
		if (recognition) recognition.stop();
		const arrayBuff = base64ToArrBuff(sounds);
		arraybufferToAudiobuffer(arrayBuff, audioCtx).then((audioBuffer) => {
			const source = audioCtx.createBufferSource();
			source.buffer = audioBuffer;
			source.connect(audioCtx.destination);
			source.start();
			source.onended = () => {
				isSpeaking = false;
				if (recognition && !sounds.length) recognition.start();
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
	function onTranscription(msg) {
		printSpeach(msg);
		socket.send(msg);
	}
	function onStatus(msg) {
		partialContainer.textContent = msg;
	}

	const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (typeof SpeechRecognition !== 'undefined') {
		recognition = new SpeechRecognition();
		recognition.continuous = true;
		recognition.onresult = ({ results }) => {
			const transcript = results[results.length - 1][0].transcript;
			onTranscription(transcript);
		};
		recognition.start();
		return undefined;
	}

	moonshot(onStatus, onTranscription);
}

window.init = init;
// window.onload = init;
