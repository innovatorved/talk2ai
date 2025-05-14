import { SAMPLE_RATE } from './constants.js';
import { formatDate } from './utils.js';

const PATH = '/local-tts';
export function moonshot(onTranscription, onStatus, socket) {
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
				const arrayBuffer = float32ArraysToWav([data.buffer], SAMPLE_RATE);
				socket.send(arrayBuffer);
				// const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
				// const url = window.URL.createObjectURL(blob);
				// const audio = new Audio();
				// audio.src = url;
				// audio.play();
				// socket.send(JSON.stringify(data.message));
				// onTranscription(data.message);
				break;
		}
	};
	worker.addEventListener('error', onError);
	worker.addEventListener('message', onMessage);

	const audioStream = navigator.mediaDevices.getUserMedia({
		audio: {
			channelCount: 1,
			echoCancellation: true,
			autoGainControl: true,
			noiseSuppression: true,
			sampleRate: SAMPLE_RATE,
		},
	});

	audioStream
		.then(async (stream) => {
			let actualSampleRate;
			if (stream.getAudioTracks().length > 0) {
				const audioTrack = stream.getAudioTracks()[0];
				const trackSettings = audioTrack.getSettings();
				actualSampleRate = trackSettings.sampleRate;
				console.log('Actual microphone stream sample rate:', actualSampleRate);
			}
			console.log({ actualSampleRate });

			const audioContext = new (window.AudioContext || window.webkitAudioContext)({
				sampleRate: SAMPLE_RATE,
				latencyHint: 'interactive',
			});

			console.log(audioContext.sampleRate);

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
				// console.log(buffer);

				// Dispatch buffer for voice activity detection
				worker.postMessage({ buffer });
			};
		})
		.catch((err) => {
			console.error(err);
		});
}

function float32ArraysToWav(channelsData, sampleRate, bitsPerSample = 16) {
	if (!Array.isArray(channelsData) || !channelsData.length || !(channelsData[0] instanceof Float32Array)) {
		throw new Error("Invalid 'channelsData' format. Expected an array of Float32Arrays.");
	}

	const numChannels = channelsData.length;
	const numFrames = channelsData[0].length; // Number of samples per channel

	// Verify all channels have the same length
	for (let i = 1; i < numChannels; i++) {
		if (channelsData[i].length !== numFrames) {
			throw new Error('All channels must have the same number of samples (frames).');
		}
	}

	if (bitsPerSample !== 8 && bitsPerSample !== 16) {
		// This basic encoder is primarily for 8-bit or 16-bit PCM.
		// 32-bit float WAV requires audioFormat=3 in the header, and this encoder uses 1 (PCM).
		throw new Error('This encoder supports 8-bit or 16-bit PCM. For 32-bit float WAV, header adjustments are needed.');
	}

	const bytesPerSampleValue = bitsPerSample / 8;
	const blockAlign = numChannels * bytesPerSampleValue;
	const byteRate = sampleRate * blockAlign;
	const dataSize = numFrames * blockAlign;

	// WAV header is 44 bytes
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	function writeString(view, offset, string) {
		for (let i = 0; i < string.length; i++) {
			view.setUint8(offset + i, string.charCodeAt(i));
		}
	}

	// RIFF chunk descriptor
	writeString(view, 0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true); // chunkSize (total file size - 8 bytes)
	writeString(view, 8, 'WAVE');

	// FMT sub-chunk (describes the sound data's format)
	writeString(view, 12, 'fmt ');
	view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
	view.setUint16(20, 1, true); // AudioFormat (1 for PCM - Linear Quantization)
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true); // (Sample Rate * Number of Channels * BitsPerSample / 8)
	view.setUint16(32, blockAlign, true); // (Number of Channels * BitsPerSample / 8)
	view.setUint16(34, bitsPerSample, true);

	// DATA sub-chunk (contains the actual sound data)
	writeString(view, 36, 'data');
	view.setUint32(40, dataSize, true); // Subchunk2Size (Number of Samples * Number of Channels * BitsPerSample / 8)

	// Write the PCM data (interleaved)
	let offset = 44;
	for (let i = 0; i < numFrames; i++) {
		// Iterate over samples/frames
		for (let channel = 0; channel < numChannels; channel++) {
			// Iterate over channels
			const sampleFloat = channelsData[channel][i];
			let sampleValue;

			if (bitsPerSample === 16) {
				// Convert Float32 sample from [-1.0, 1.0] to Int16 [-32768, 32767]
				sampleValue = Math.max(-1, Math.min(1, sampleFloat)); // Clamp to [-1, 1]
				sampleValue = sampleValue < 0 ? sampleValue * 0x8000 : sampleValue * 0x7fff;
				view.setInt16(offset, sampleValue, true); // true for little-endian
			} else if (bitsPerSample === 8) {
				// Convert Float32 sample from [-1.0, 1.0] to Uint8 [0, 255] (128 is silence)
				sampleValue = ((Math.max(-1, Math.min(1, sampleFloat)) + 1) / 2) * 255;
				view.setUint8(offset, Math.round(sampleValue));
			}
			offset += bytesPerSampleValue;
		}
	}

	return buffer;
}
