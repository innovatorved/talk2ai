import { SAMPLE_RATE } from './constants.js';
import { formatDate } from './utils.js';

const PATH = '/moonshot';
export function moonshot(onStatus, onTranscription) {
	const worker = new Worker(PATH + '/worker.js', { type: 'module' });

	const onError = (error) => console.log(error);
	const onMessage = async ({ data }) => {
		if (data.error) {
			return onError(data.error);
		}
		// console.log(data);
		if (data.type === 'status') {
			onStatus(data.message);
		} else if (data.type === 'info') {
			onStatus(data.message);
		} else {
			onTranscription(data.message);
		}
	};
	worker.addEventListener('message', onMessage);
	worker.addEventListener('error', onError);

	const audioStream = navigator.mediaDevices.getUserMedia({
		audio: {
			channelCount: 1,
			echoCancellation: true,
			autoGainControl: true,
			noiseSuppression: true,
			sampleRate: SAMPLE_RATE,
		},
	});

	// let worklet;
	// let audioContext;
	// let source;

	audioStream
		.then(async (stream) => {
			const audioContext = new (window.AudioContext || window.webkitAudioContext)({
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
			const source = audioContext.createMediaStreamSource(stream);
			source.connect(analyser);

			await audioContext.audioWorklet.addModule(PATH + '/processor.js');

			const worklet = new AudioWorkletNode(audioContext, 'vad-processor', {
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
