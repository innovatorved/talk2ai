import { stopPlaying } from './utils.js';

const stopButton = document.getElementById('stopButton');
const statusText = document.getElementById('statusText');
const startButton = document.getElementById('startButton');
const messagesArea = document.getElementById('messagesArea');
const clearChatButton = document.getElementById('clearChatButton');
const voiceVisualizationArea = document.getElementById('voiceVisualizationArea');
const voiceBars = Array.from(voiceVisualizationArea.querySelectorAll('.voice-bar'));

window.conversationActive = false; // tracks if VAD and ws interaction is active

const MIN_BAR_HEIGHT = 5;
const MAX_BAR_HEIGHT_MOBILE = 30;
const MAX_BAR_HEIGHT_DESKTOP = 40;
let currentMaxBarHeight = MAX_BAR_HEIGHT_MOBILE;
const INITIAL_MESSAGE = 'Hello! Click "Start" to begin.';

window.setStatus = function (text) {
	statusText.textContent = text;
};

window.updateButtonText = function () {
	const isMobile = window.innerWidth < 640;
	startButton.textContent = isMobile ? 'Start' : 'Start Conversation';
	stopButton.textContent = isMobile ? 'Stop' : 'Stop Conversation';
	clearChatButton.textContent = isMobile ? 'Clear' : 'Clear Chat';
	currentMaxBarHeight = isMobile ? MAX_BAR_HEIGHT_MOBILE : MAX_BAR_HEIGHT_DESKTOP;
};

window.addInitialMessage = function () {
	messagesArea.innerHTML = ''; // c previous messages first
	const messageBubble = document.createElement('div');
	messageBubble.classList.add('message-bubble', 'ai-message');
	const p = document.createElement('p');
	p.textContent = INITIAL_MESSAGE;
	messageBubble.appendChild(p);
	messagesArea.appendChild(messageBubble);
	messagesArea.scrollTop = messagesArea.scrollHeight;
};

window.addMessage = function (text, sender) {
	const messageBubble = document.createElement('div');
	messageBubble.classList.add('message-bubble', sender === 'user' ? 'user-message' : 'ai-message');
	const p = document.createElement('p');
	p.textContent = text;
	messageBubble.appendChild(p);

	if (sender === 'ai') {
		setStatus('AI Speaking...');
		// remove "thinking" indicator if AI speaks quickly
		if (thinkingTimeoutId) clearTimeout(thinkingTimeoutId);
		const existingThinkingIndicator = messageBubble.querySelector('.ai-speaking-indicator');
		if (existingThinkingIndicator) existingThinkingIndicator.remove();
	} else if (sender === 'user' && conversationActive) {
		setStatus('Listening...');
	}

	messagesArea.appendChild(messageBubble);
	messagesArea.scrollTop = messagesArea.scrollHeight;
};

window.showThinkingIndicator = function (show) {
	if (show) {
		setStatus('Processing...');
	} else {
		if (statusText.textContent === 'Processing...' && conversationActive) {
			setStatus('Listening...');
		}
	}
};

window.updateUserVoiceVisualization = function () {
	if (!conversationActive) return;
	voiceBars.forEach((bar) => {
		const randomHeight = Math.floor(Math.random() * (currentMaxBarHeight - MIN_BAR_HEIGHT + 1)) + MIN_BAR_HEIGHT;
		const randomOpacity = Math.random() * 0.4 + 0.6;
		bar.style.height = `${randomHeight}px`;
		bar.style.opacity = randomOpacity;
	});
};

window.handleStartConversation = async function () {
	if (conversationActive) return;

	connectWebSocket();

	const vadReady = await initializeVADSystem();
	if (!vadReady) {
		// ui state should reflect this, perhaps disable start button until refresh
		startButton.disabled = false;
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

	if (messagesArea.children.length <= 1 && messagesArea.textContent.includes(INITIAL_MESSAGE.substring(0, 10))) {
		messagesArea.innerHTML = '';
		addMessage('Conversation started.', 'ai');
	} else {
		addMessage('Conversation resumed.', 'ai');
	}
	setStatus('Listening...');
};

window.handleStopConversation = function () {
	if (!conversationActive && !vadInitialized) return;

	conversationActive = false;
	// disable mic
	window.stream.getTracks().forEach((track) => {
		if (track.readyState == 'live') track.enabled = false;
	});

	if (vadInitialized) {
		// only add "Conversation ended" if VAD was actually running
		addMessage('Conversation ended.', 'ai');
		setStatus('Ended. Click Start to resume.');
	} else {
		setStatus('Ready. Click Start.');
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

	stopPlaying();
};

window.handleClearChat = function () {
	messagesArea.innerHTML = '';
	addInitialMessage();
	setStatus(`Chat cleared. Click "${startButton.textContent}" to begin.`);

	if (conversationActive) {
		// if conversation was active, stop it gracefully
		handleStopConversation();
	} else {
		// ensure buttons are in correct state if chat is cleared while inactive
		startButton.disabled = false;
		stopButton.disabled = true;
		clearChatButton.disabled = false;
		voiceVisualizationArea.style.display = 'none';
	}
	stopPlaying();
	socket.send(JSON.stringify({ type: 'cmd', data: 'clear' }));
};

// init
updateButtonText(); // set initial button text based on screen size
window.addEventListener('resize', updateButtonText);

addInitialMessage();
voiceVisualizationArea.style.display = 'none';
stopButton.disabled = true;
startButton.disabled = false;
clearChatButton.disabled = false;
messagesArea.scrollTop = messagesArea.scrollHeight;

startButton.addEventListener('click', handleStartConversation);
stopButton.addEventListener('click', handleStopConversation);
clearChatButton.addEventListener('click', handleClearChat);
