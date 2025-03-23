import { SAMPLE_RATE } from './constants.js';
import { formatDate } from './utils.js';
// Create WebSocket connection.
const socket = new WebSocket('ws://localhost:8787/websocket');
// Connection opened
socket.addEventListener('open', (event) => {
	socket.send('Hello Server!');
});
// Listen for messages
socket.addEventListener('message', (event) => {
	console.log('Message from server ', event.data);
});

async function init() {
	const worker = new Worker('worker.js', { type: 'module' });
	const resultsContainer = document.getElementById('recognition-result');
	const partialContainer = document.getElementById('partial');

	const onError = (error) => console.log(error);
	const onMessage = async ({ data }) => {
		if (data.error) {
			return onError(data.error);
		}
		if (data.type === 'status') {
			partialContainer.textContent = data.message;
			// console.log(data.message);
		} else {
			const newSpan = document.createElement('div');
			newSpan.textContent = `${data.message} `;
			resultsContainer.insertBefore(newSpan, partialContainer);
			socket.send(data.message);
			console.log(data.message);
		}
	};
	worker.addEventListener('message', onMessage);
	worker.addEventListener('error', onError);
	await next(worker);
}
async function next(worker) {
	const audioStream = navigator.mediaDevices.getUserMedia({
		audio: {
			channelCount: 1,
			echoCancellation: true,
			autoGainControl: true,
			noiseSuppression: true,
			sampleRate: SAMPLE_RATE,
		},
	});

	let worklet;
	let audioContext;
	let source;

	audioStream
		.then(async (stream) => {
			audioContext = new (window.AudioContext || window.webkitAudioContext)({
				sampleRate: SAMPLE_RATE,
				latencyHint: 'interactive',
			});

			const analyser = audioContext.createAnalyser();
			analyser.fftSize = 32;

			// NOTE: In Firefox, the following line may throw an error:
			// "AudioContext.createMediaStreamSource: Connecting AudioNodes from AudioContexts with different sample-rate is currently not supported."
			// See the following bug reports for more information:
			//  - https://bugzilla.mozilla.org/show_bug.cgi?id=1674892
			//  - https://bugzilla.mozilla.org/show_bug.cgi?id=1674892
			source = audioContext.createMediaStreamSource(stream);
			source.connect(analyser);

			await audioContext.audioWorklet.addModule('./processor.js');

			worklet = new AudioWorkletNode(audioContext, 'vad-processor', {
				numberOfInputs: 1,
				numberOfOutputs: 0,
				channelCount: 1,
				channelCountMode: 'explicit',
				channelInterpretation: 'discrete',
			});

			source.connect(worklet);

			worklet.port.onmessage = (event) => {
				const { buffer } = event.data;

				// Dispatch buffer for voice activity detection
				worker.postMessage({ buffer });
			};
		})
		.catch((err) => {
			console.error(err);
		});
}

window.onload = init;
