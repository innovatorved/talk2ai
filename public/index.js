import { vad } from './vad/index.js';
import { base64ToArrBuff, queueSound, stopPlaying } from './utils.js';
import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

// Assuming arraybufferToAudiobuffer is available globally via CDN or a module loader
// import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

// --- UI Elements ---
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const clearChatButton = document.getElementById('clearChatButton');
const voiceVisualizationArea = document.getElementById('voiceVisualizationArea');
const voiceBars = Array.from(voiceVisualizationArea.querySelectorAll('.voice-bar'));
const messagesArea = document.getElementById('messagesArea');
const statusText = document.getElementById('statusText');
const firefoxModal = document.getElementById('firefoxModal');
const closeFirefoxModalButton = document.getElementById('closeFirefoxModal');

// --- UI State & Config ---
let conversationActive = false; // Tracks if VAD and WebSocket interaction is active
let vadInitialized = false; // Tracks if VAD has been successfully initialized
let visualizationIntervalId;
let thinkingTimeoutId;

const MIN_BAR_HEIGHT = 5;
const MAX_BAR_HEIGHT_MOBILE = 30;
const MAX_BAR_HEIGHT_DESKTOP = 40;
let currentMaxBarHeight = MAX_BAR_HEIGHT_MOBILE;

const INITIAL_MESSAGE = 'Hello! Click "Start" to begin.';

// --- UI Helper Functions ---
function setStatus(text) {
	statusText.textContent = text;
}
function updateButtonText() {
	const isMobile = window.innerWidth < 640;
	startButton.textContent = isMobile ? 'Start' : 'Start Conversation';
	stopButton.textContent = isMobile ? 'Stop' : 'Stop Conversation';
	clearChatButton.textContent = isMobile ? 'Clear' : 'Clear Chat';
	currentMaxBarHeight = isMobile ? MAX_BAR_HEIGHT_MOBILE : MAX_BAR_HEIGHT_DESKTOP;
}

function addInitialMessage() {
	messagesArea.innerHTML = ''; // Clear previous messages first
	const messageBubble = document.createElement('div');
	messageBubble.classList.add('message-bubble', 'ai-message');
	const p = document.createElement('p');
	p.textContent = INITIAL_MESSAGE;
	messageBubble.appendChild(p);
	messagesArea.appendChild(messageBubble);
	messagesArea.scrollTop = messagesArea.scrollHeight;
}

function addMessage(text, sender) {
	const messageBubble = document.createElement('div');
	messageBubble.classList.add('message-bubble', sender === 'user' ? 'user-message' : 'ai-message');
	const p = document.createElement('p');
	p.textContent = text;
	messageBubble.appendChild(p);

	if (sender === 'ai') {
		setStatus('AI Speaking...');
		// Remove "thinking" indicator if AI speaks quickly
		if (thinkingTimeoutId) clearTimeout(thinkingTimeoutId);
		const existingThinkingIndicator = messageBubble.querySelector('.ai-speaking-indicator');
		if (existingThinkingIndicator) existingThinkingIndicator.remove();
	} else if (sender === 'user' && conversationActive) {
		setStatus('Listening...'); // User finished speaking, back to listening
	}

	messagesArea.appendChild(messageBubble);
	messagesArea.scrollTop = messagesArea.scrollHeight;
}

function showThinkingIndicator(show) {
	// This function could be used to show a global thinking indicator
	// For now, the "AI is thinking..." is part of the message bubble logic in printSpeach
	if (show) {
		setStatus('Processing...');
	} else {
		if (statusText.textContent === 'Processing...' && conversationActive) {
			setStatus('Listening...');
		}
	}
}

function updateUserVoiceVisualization() {
	if (!conversationActive) return;
	voiceBars.forEach((bar) => {
		const randomHeight = Math.floor(Math.random() * (currentMaxBarHeight - MIN_BAR_HEIGHT + 1)) + MIN_BAR_HEIGHT;
		const randomOpacity = Math.random() * 0.4 + 0.6;
		bar.style.height = `${randomHeight}px`;
		bar.style.opacity = randomOpacity;
	});
}

function showFirefoxWarning() {
	firefoxModal.classList.add('active');
}
closeFirefoxModalButton.addEventListener('click', () => firefoxModal.classList.remove('active'));

let socket;

function connectWebSocket() {
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
			case 'audio': // AI response
				printSpeach(data.text, 'output'); // Displays AI text
				queueSound(data.audio, setStatus); // Plays AI audio
				break;
			case 'text': // User's transcribed speech
				printSpeach(data.text, 'input'); // Displays user text
				break;
			default:
				console.warn('Unknown WebSocket message type:', data.type);
				break;
		}
	};

	socket.onerror = (error) => {
		console.error('WebSocket Error:', error);
		setStatus('Connection error. Try refreshing.');
		// Consider more robust error handling or reconnection logic here
	};

	socket.onclose = (event) => {
		console.log('WebSocket connection closed:', event.reason);
		if (conversationActive) {
			// If connection drops during active convo
			setStatus('Connection lost. Please Stop and Start again.');
		} else {
			setStatus('Disconnected. Ready to connect.');
		}
		// Optionally, you might want to disable Stop button or re-enable Start if appropriate
	};
}

// Modified printSpeach to use UI's addMessage
function printSpeach(msg, type = 'input') {
	if (type === 'input') {
		// User's speech
		addMessage(msg, 'user');
	} else {
		// AI's response ('output')
		addMessage(msg, 'ai');
	}
}

async function initializeVADSystem() {
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

	function onAudioBuffer(buff) {
		if (socket && socket.readyState === WebSocket.OPEN) {
			stopPlaying(); // Stop any AI audio before sending user audio
			socket.send(buff);
			// UI might show a "Sending..." or "User speaking..." status here briefly
			// For now, VAD onStatus handles partial transcriptions.
		} else {
			console.warn('WebSocket not open. Cannot send audio.');
			setStatus('Connection issue. Cannot send audio.');
		}
	}

	function onVADStatus(msg) {
		// This msg is often a partial transcript
		if (conversationActive) setStatus(`Listening: ${msg}`);
	}

	try {
		await vad(onAudioBuffer, onVADStatus); // Initialize VAD
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
}

// --- UI Event Handlers ---
async function handleStartConversation() {
	if (conversationActive) return;

	connectWebSocket(); // Ensure WebSocket is connected or connecting

	const vadReady = await initializeVADSystem();
	if (!vadReady) {
		// VAD failed to initialize (e.g., Firefox or other error)
		// UI state should reflect this, perhaps disable start button until refresh
		startButton.disabled = false; // Allow retry, though might need refresh for permissions
		stopButton.disabled = true;
		clearChatButton.disabled = false;
		return;
	}

	conversationActive = true;
	startButton.disabled = true;
	stopButton.disabled = false;
	clearChatButton.disabled = true;

	voiceVisualizationArea.style.display = 'flex';
	if (visualizationIntervalId) clearInterval(visualizationIntervalId);
	visualizationIntervalId = setInterval(updateUserVoiceVisualization, 120);

	// Clear initial message if it's the only one or present
	if (messagesArea.children.length <= 1 && messagesArea.textContent.includes(INITIAL_MESSAGE.substring(0, 10))) {
		messagesArea.innerHTML = '';
		addMessage('Conversation started.', 'ai'); // Inform user
	} else {
		addMessage('Conversation resumed.', 'ai');
	}
	setStatus('Listening...'); // Set after VAD init
}

function handleStopConversation() {
	if (!conversationActive && !vadInitialized) return; // Nothing to stop if not active or VAD never started

	conversationActive = false;
	// disable mic
	window.stream.getTracks().forEach((track) => {
		if (track.readyState == 'live') track.enabled = false;
	});

	if (vadInitialized) {
		// Only add "Conversation ended" if VAD was actually running
		addMessage('Conversation ended.', 'ai');
		setStatus('Ended. Click Start to resume.');
	} else {
		setStatus('Ready. Click Start.'); // If VAD never started but stop was clicked
	}

	startButton.disabled = false;
	stopButton.disabled = true;
	clearChatButton.disabled = false;

	clearInterval(visualizationIntervalId);
	visualizationIntervalId = null;
	voiceBars.forEach((bar) => {
		bar.style.height = `${MIN_BAR_HEIGHT}px`;
		bar.style.opacity = '0.5';
	});
	setTimeout(() => {
		if (!conversationActive) voiceVisualizationArea.style.display = 'none';
	}, 200);

	stopPlaying(); // Stop any currently playing AI audio

	if (socket && socket.readyState === WebSocket.OPEN) {
		// Optionally send a 'stop_conversation' message to backend
		// socket.send(JSON.stringify({ type: 'control', action: 'stop_conversation' }));
	}
	// Don't close WebSocket here, allow user to restart conversation
}

function handleClearChat() {
	messagesArea.innerHTML = '';
	addInitialMessage();
	setStatus(`Chat cleared. Click "${startButton.textContent}" to begin.`);

	if (conversationActive) {
		// If conversation was active, stop it gracefully
		handleStopConversation(); // This will also re-enable buttons correctly
	} else {
		// Ensure buttons are in correct state if chat is cleared while inactive
		startButton.disabled = false;
		stopButton.disabled = true;
		clearChatButton.disabled = false;
		voiceVisualizationArea.style.display = 'none';
	}
	stopPlaying(); // Clear any queued sounds
	socket.send(JSON.stringify({ type: 'cmd', data: 'clear' }));
}

// --- Initial Setup ---
updateButtonText(); // Set initial button text based on screen size
window.addEventListener('resize', updateButtonText);

startButton.addEventListener('click', handleStartConversation);
stopButton.addEventListener('click', handleStopConversation);
clearChatButton.addEventListener('click', handleClearChat);

addInitialMessage();
voiceVisualizationArea.style.display = 'none';
stopButton.disabled = true;
startButton.disabled = false;
clearChatButton.disabled = false;
messagesArea.scrollTop = messagesArea.scrollHeight;

// Attempt to connect WebSocket on load, but don't start VAD yet
// This allows the server to know a client is present earlier.
// Or, connect WebSocket only when "Start" is clicked (current implementation in handleStartConversation)
// For now, WebSocket connects on Start.
// connectWebSocket();
