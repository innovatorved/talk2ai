import { SAMPLE_RATE } from './constants.js';
import { float32ArraysToWav, playAudioBuffer } from './utils.js';

const PATH = '/vad';

export async function vad(onAudioBuffer, onStatus) {
	const worker = new Worker(PATH + '/worker.js', { type: 'module' });

	const onError = (error) => console.log(error);
	const onMessage = async ({ data }) => {
		if (data.error) return onError(data.error);

		switch (data.type) {
			case 'status':
			case 'info':
				onStatus(data.message);
				break;
			default:
				const buff = float32ArraysToWav([data.buffer], SAMPLE_RATE);
				// playAudioBuffer(buff);
				onAudioBuffer(buff);
				break;
		}
	};
	worker.addEventListener('error', onError);
	worker.addEventListener('message', onMessage);

	const stream = await navigator.mediaDevices.getUserMedia({
		audio: {
			channelCount: 1,
			echoCancellation: true,
			autoGainControl: true,
			noiseSuppression: true,
			sampleRate: SAMPLE_RATE,
		},
	});
	window.stream = stream;

	const audioContext = new (window.AudioContext || window.webkitAudioContext)({
		sampleRate: SAMPLE_RATE,
		latencyHint: 'interactive',
	});

	const microphoneSource = audioContext.createMediaStreamSource(stream);
	const analyser = audioContext.createAnalyser();
	analyser.fftSize = 32;
	microphoneSource.connect(analyser);

	await audioContext.audioWorklet.addModule(PATH + '/processor.js');

	const chunkNode = new AudioWorkletNode(audioContext, 'chunk-processor', {
		numberOfInputs: 1,
		numberOfOutputs: 0,
		channelCount: 1,
		channelCountMode: 'explicit',
		channelInterpretation: 'discrete',
	});

	microphoneSource.connect(chunkNode);
	chunkNode.port.onmessage = (event) => {
		const { buffer } = event.data;
		worker.postMessage({ buffer });
	};
	// audioStream
	// 	.then(async (stream) => {
	// 	})
	// 	.catch((err) => {
	// 		console.error(err);
	// 	});
}
