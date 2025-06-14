import { vad } from './vad/index.js';
import { base64ToArrBuff, queueSound, stopPlaying } from './utils.js';
import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';
import Module from './whisper.wasm/main.js';
import { loadRemote } from './whisper.wasm/helpers.js';

// app state
window.socket = undefined;
window.vadInitialized = false;
window.thinkingTimeoutId = undefined;
window.visualizationIntervalId = undefined;

// Whisper state
window.isTranscribing = false;
window.whisperModule = undefined; // Will hold the initialized Whisper module
window.whisperModelName = 'tiny.en-q5_1.bin'; // Default model
window.whisperModelLoaded = false;
window.modelLoadingInProgress = false; // To prevent multiple loading attempts

// Setup Module print/printErr for Whisper.wasm, in case it logs anything internally.
// These need to be on the Module object that whisper.wasm/main.js enhances.
if (typeof Module === 'undefined') { // Should not happen with static import, but good check
	var Module = {};
}
Module.print = (text) => console.log('WASM:', text);
Module.printErr = (text) => console.error('WASM:', text);


window.connectWebSocket = function () {
	if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
		console.log('WebSocket already open or connecting.');
		return;
	}
	socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/websocket`);

	socket.onopen = () => {
		console.log('WebSocket connection established.');
		setStatus(vadInitialized ? 'Listening...' : 'Ready to initialize VAD.');
	};

	socket.onmessage = async (event) => {
		const data = JSON.parse(event.data);
		switch (data.type) {
			case 'audio': // ai's response
				printSpeach(data.text, 'ai'); // displays text
				queueSound(data.audio, setStatus); // plays audio
				break;
			case 'text': // user's transcribed speech
				printSpeach(data.text, 'user'); // displays user text
				break;
			default:
				console.warn('Unknown WebSocket message type:', data.type);
				break;
		}
	};

	socket.onerror = (error) => {
		console.error('WebSocket Error:', error);
		setStatus('Connection error. Try refreshing.');
	};

	socket.onclose = (event) => {
		console.log('WebSocket connection closed:', event.reason);
		if (window.conversationActive) {
			setStatus('Connection lost. Please Stop and Start again.');
		} else {
			setStatus('Disconnected. Ready to connect.');
		}
	};
};

// Helper to store model in WASM FS
// Adapted from public/whisper.wasm/index.html
function storeFS(fname, buf) {
	// Check if Module and FS are available
	if (!Module || !Module.FS_createDataFile) {
		console.error('Module or Module.FS_createDataFile is not available.');
		setStatus('Error: Whisper module not ready for FS operation.');
		return false;
	}
	try {
		// Check if file exists and unlink if it does
		// FS.lookupPath is not directly available, so we try unlinking and catch if it fails
		try {
			Module.FS_unlink(fname);
		} catch (e) {
			// Ignore if file doesn't exist or FS_unlink is not found initially (might happen if FS not fully ready)
		}
		Module.FS_createDataFile('/', fname, buf, true, true, true); // Ensure it's usable by WASM
		console.log('storeFS: stored model: ' + fname + ' size: ' + buf.length);
		setStatus(`Model ${fname} stored in WASM FS.`);
		return true;
	} catch (e) {
		console.error('storeFS: failed to store model: ' + fname, e);
		setStatus(`Error storing model ${fname}.`);
		return false;
	}
}


window.printSpeach = function (msg, type = 'user') {
	if (type === 'user') {
		addMessage(msg, 'user');
	} else {
		addMessage(msg, 'ai');
	}
};

window.initializeVADSystem = async function () {
	if (vadInitialized) {
		window.stream.getTracks().forEach((track) => {
			if (track.readyState == 'live') track.enabled = true;
		});
		console.log('VAD already initialized.');
		return true;
	}
	setStatus('Initializing VAD...');

	const isFirefox = navigator.userAgent.indexOf('Firefox') !== -1;
	if (isFirefox) {
		showFirefoxWarning();
		setStatus('Firefox not supported.');
		return false; // VAD initialization failed
	}

	function onAudioBuffer(audioBuffer) { // buff is an AudioBuffer object
		if (isTranscribing) {
			console.log('Already transcribing, skipping this buffer.');
			return;
		}

		if (!whisperModelLoaded || !whisperModule) {
			setStatus('Whisper model not loaded yet.');
			console.warn('Whisper model not loaded yet.');
			// Optionally, trigger model loading here if it failed or wasn't initiated
			// if (!whisperModelLoaded && !window.modelLoadingInProgress) {
			//   loadWhisperModel();
			// }
			return;
		}

		isTranscribing = true;
		setStatus('Transcribing...');
		stopPlaying(); // stop any ai audio

		try {
			const pcm = audioBuffer.getChannelData(0); // Get PCM data for the first channel

			// Ensure Module.full_default is available
			if (!whisperModule || typeof whisperModule.full_default !== 'function') {
				console.error("whisperModule.full_default is not available!");
				setStatus("Transcription error.");
				isTranscribing = false;
				return;
			}

			console.log(`Transcribing audio chunk, length: ${pcm.length}`);

			const nthreads = navigator.hardwareConcurrency ? Math.max(1, Math.floor(navigator.hardwareConcurrency / 2)) : 1;
			const lang = 'en'; // Hardcoded for now
			const translate = false;

			// Call Whisper.wasm transcription function
			// The instance is now part of whisperModule after Module.init()
			// Module.full_default(instance, pcm_f32, lang.c_str(), n_threads, false /*translate*/);
			const transcribedText = whisperModule.full_default(pcm, lang, nthreads, translate);

			console.log('Transcription result:', transcribedText);

			if (transcribedText && transcribedText.trim() !== "") {
				printSpeach(transcribedText, 'user');
				// If socket is still used for sending AI text responses or other commands:
				if (socket && socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: 'text', text: transcribedText, toClient: false, fromClient: true }));
				}
			}
		} catch (e) {
			console.error('Error during transcription:', e);
			setStatus('Transcription failed.');
		} finally {
			isTranscribing = false;
			if (window.conversationActive) setStatus('Listening...');
		}

		// socket.send(buff); // Original WebSocket sending - REMOVED
	}

	function onVADStatus(msg) {
		if (window.conversationActive) setStatus(`Listening: ${msg}`);
	}

	try {
		await vad(onAudioBuffer, onVADStatus); // Initialize VAD
		vadInitialized = true;
		console.log('VAD initialized successfully.');
		setStatus('VAD initialized. Loading Whisper model...');
		// Don't await model loading, let it happen in background
		loadWhisperModel().then(() => {
			if (window.conversationActive) setStatus('Listening...');
		}).catch(err => {
			console.error("Failed to load whisper model from initializeVADSystem", err);
			setStatus('Failed to load Whisper model.');
		});
		return true;
	} catch (error) {
		console.error('Error initializing VAD:', error);
		setStatus('VAD initialization failed.');
		vadInitialized = false;
		return false;
	}
};

// Whisper.wasm model loading function
async function loadWhisperModel() {
	if (whisperModelLoaded) {
		console.log('Whisper model already loaded.');
		return;
	}
	if (window.modelLoadingInProgress) {
		console.log('Whisper model loading already in progress.');
		return;
	}
	window.modelLoadingInProgress = true;
	setStatus('Loading Whisper model: ' + whisperModelName);
	console.log('Loading Whisper model: ' + whisperModelName);

	const modelRegistry = {
		// Using a quantized model for faster loading and smaller size
		'tiny.en-q5_1.bin': {
			url: 'https://whisper.ggerganov.com/ggml-model-whisper-tiny.en-q5_1.bin',
			size_mb: 31,
			dst: 'whisper.bin' // Filename in WASM FS
		},
		'tiny.en.bin': { // Fallback or alternative
			url: 'https://whisper.ggerganov.com/ggml-model-whisper-tiny.en.bin',
			size_mb: 75,
			dst: 'whisper.bin'
		},
		'base.en-q5_1.bin': {
			url: 'https://whisper.ggerganov.com/ggml-model-whisper-base.en-q5_1.bin',
			size_mb: 57,
			dst: 'whisper.bin'
		}
		// Add other models as needed
	};

	const modelParams = modelRegistry[whisperModelName];
	if (!modelParams) {
		console.error(`Model ${whisperModelName} not found in registry.`);
		setStatus(`Error: Model ${whisperModelName} not defined.`);
		window.modelLoadingInProgress = false;
		return;
	}

	const { url, dst, size_mb } = modelParams;

	function progressCallback(progress) {
		const percentage = Math.round(progress * 100);
		setStatus(`Loading model: ${percentage}%`);
		console.log(`Loading model: ${percentage}%`);
	}

	function readyCallback(filename, dataBuffer) {
		console.log(`Model ${filename} data received, length: ${dataBuffer.length}`);
		setStatus('Model downloaded. Storing in file system...');
		if (storeFS(filename, new Uint8Array(dataBuffer))) { // storeFS expects Uint8Array
			console.log(`Attempting to initialize Whisper with model: ${filename}`);
			try {
				// Module itself is what whisper.wasm/main.js exports.
				// Module.init is a function we expect to be on it.
				if (!Module || !Module.init) {
					console.error("Module.init is not available!");
					setStatus("Error: Whisper module not properly loaded.");
					whisperModelLoaded = false;
					window.modelLoadingInProgress = false;
					// Try to define Module.print/printErr if they are missing, as init might use them
					Module.print = Module.print || ((text) => console.log('WASM:', text));
					Module.printErr = Module.printErr || ((text) => console.error('WASM:', text));
					return;
				}
				whisperModule = Module.init(filename); // filename is 'whisper.bin'
				if (whisperModule) {
					// Check if full_default is now a method of whisperModule
					if (typeof whisperModule.full_default !== 'function') {
						console.warn('whisperModule.full_default is not a function. The Module.init might have returned a status or a different object structure than expected. Will try to call Module.full_default directly.');
						// Fallback or alternative check: if whisperModule is a context/instance pointer (e.g., a number)
						// and full_default is a global on Module. This depends on Whisper.wasm's specific Emscripten bindings.
						// For now, the primary assumption is that whisperModule *is* the object with methods.
					}
					console.log('Whisper initialized successfully, instance:', whisperModule);
					setStatus('Whisper model loaded.');
					whisperModelLoaded = true;
				} else {
					console.error('Failed to initialize Whisper module. Module.init did not return a truthy value.');
					setStatus('Whisper initialization failed.');
					whisperModelLoaded = false;
				}
			} catch (e) {
				console.error('Error initializing Whisper:', e);
				setStatus('Whisper initialization error.');
				whisperModelLoaded = false;
			}
		} else {
			console.error(`Failed to store ${filename} in WASM FS.`);
			setStatus('Failed to store model in FS.');
		}
		window.modelLoadingInProgress = false;
	}

	function cancelCallback() {
		console.log('Model loading cancelled.');
		setStatus('Model loading cancelled.');
		window.modelLoadingInProgress = false;
	}

	function printCallbackForLoadRemote(text) { // Used by loadRemote for its own logging
		console.log(`loadRemote: ${text}`);
		// setStatus(`Model loader: ${text}`); // This might be too verbose for main status
	}

	try {
		// Ensure Module and its FS operations are ready.
		// Emscripten usually sets up Module and FS early. If FS_createDataFile is there, FS is likely ready.
		if (!Module || typeof Module.FS_createDataFile !== 'function') {
			console.warn("Whisper Module or FS_createDataFile not ready yet. This might indicate an issue with whisper.wasm/main.js loading or initialization order.");
			// It's possible Module.onRuntimeInitialized could be used if whisper.wasm/main.js supported it,
			// but helpers.js (loadRemote) doesn't seem to wait for such an event.
			// The storeFS function itself checks for Module.FS_createDataFile.
		}
		loadRemote(url, dst, size_mb, progressCallback, readyCallback, cancelCallback, printCallbackForLoadRemote);
	} catch (e) {
		console.error("Error in loadWhisperModel:", e);
		setStatus("Failed to load Whisper model.");
		window.modelLoadingInProgress = false;
	}
}
