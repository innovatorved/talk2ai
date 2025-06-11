import { startVad } from './vad/index.js';
import { base64ToArrBuff, queueSound, stopPlaying } from './utils.js';
import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

// app state
window.socket = undefined;
window.vadInitialized = false;
window.thinkingTimeoutId = undefined;
window.visualizationIntervalId = undefined;

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
		if (conversationActive) {
			setStatus('Connection lost. Please Stop and Start again.');
		} else {
			setStatus('Disconnected. Ready to connect.');
		}
	};
};

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

	function onAudioBuffer(buff) {
		if (socket && socket.readyState === WebSocket.OPEN) {
			stopPlaying(); // stop any ai audio before sending user audio
			socket.send(buff);
		} else {
			console.warn('WebSocket not open. Cannot send audio.');
			setStatus('Connection issue. Cannot send audio.');
		}
	}

	function onVADStatus(msg) {
		if (conversationActive) setStatus(`Listening: ${msg}`);
	}

	try {
		await startVad(onAudioBuffer, onVADStatus); // Initialize VAD
		vadInitialized = true;
		console.log('VAD initialized successfully.');
		setStatus('Listening...');
		return true;
	} catch (error) {
		console.error('Error initializing VAD:', error);
		setStatus('VAD initialization failed.');
		vadInitialized = false;
		return false;
	}
};
