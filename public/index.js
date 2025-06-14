import { vad } from './vad/index.js';
import { base64ToArrBuff, queueSound, stopPlaying } from './utils.js';
import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

// Whisper.wasm related global variables
window.instance = null;
window.model_whisper = ''; // Name of the loaded model
window.currentAudioBuffer = []; // Accumulates audio chunks for Whisper
const WHISPER_SAMPLE_RATE = 16000; // Whisper requires 16kHz mono audio
let dbVersion = 1;
let dbName    = 'whisper.ggerganov.com';
let indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
let model_name_ggml = 'whisper.bin'; // Default model filename in VFS

// App state
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

	const isFirefox = navigator.userAgent.indexOf('Firefox') !== -1;
	if (isFirefox) {
		showFirefoxWarning();
		setStatus('Firefox not supported.');
		return false; // VAD initialization failed
	}

	// Collects audio chunks from VAD
	function onAudioBuffer(buff) {
        if (buff.length > 0) {
            currentAudioBuffer.push(buff);
        }
	}

	// Handles VAD status changes, triggers transcription on speech end
	function onVADStatus(status) {
		if (conversationActive) setStatus(`VAD: ${status}`);
		// Trigger transcription when VAD detects end of speech (e.g., "INACTIVE" or "SILENCE" after "VOICE")
        // We need a more robust way to detect end of speech segment for transcription.
        // For now, let's assume "INACTIVE" after "VOICE" is the trigger.
        // A state machine (e.g., IDLE -> VOICE_ACTIVE -> AWAITING_TRANSCRIPTION) might be better.
        if (window.vadState === "VOICE" && (status === "SILENCE" || status === "INACTIVE")) {
            console.log("VAD inactive after voice, processing audio.");
            processCollectedAudio();
        }
        window.vadState = status; // Store current VAD state
	}

	try {
		// Pass WHISPER_SAMPLE_RATE to VAD initialization if it accepts sample rate,
		// otherwise ensure VAD is configured for 16kHz. Assuming VAD defaults to or is set to 16kHz.
		await vad(onAudioBuffer, onVADStatus, WHISPER_SAMPLE_RATE); // Initialize VAD
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

// Whisper.wasm Integration Code
// -----------------------------------------------------------------------------

// Adapted printTextarea to handle Whisper output
// For Whisper status messages, it uses setStatus.
// For actual transcription results, it sends to UI and WebSocket.
function whisperPrint(text) {
    if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
    console.log("Whisper output: " + text);

    // Heuristic to distinguish transcription from status messages
    // This needs to be robust. Whisper.cpp main example calls Module.print with the transcribed text.
    // Progress/status messages are often prefixed or structured differently.
    // Example whisper output: "whisper_full_with_state: progress = 100% (XXXXms)" or the actual text.
    // Let's assume if it's not a typical status line from whisper.cpp, it's transcription.
    const isLikelyStatus = text.startsWith('[') || text.startsWith('whisper_') || text.includes('progress =') || text.includes('time =');

    if (isLikelyStatus) {
        // You could show detailed Whisper progress if desired:
        // setStatus("Whisper: " + text.substring(0, 70) + "...");
        console.log("Whisper status/progress: " + text);
    } else if (text.trim().length > 0 && window.instance) {
        // Assuming this is the transcribed text
        const transcribedText = text.trim();
        printSpeach(transcribedText, 'user');
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'text', text: text.trim() }));
        } else {
            console.warn('WebSocket not open. Cannot send transcribed text.');
            setStatus('Connection issue. Cannot send transcription.');
        }
        setStatus('Listening...'); // Reset status after transcription
    }
}

window.Module = {
    print: whisperPrint,
    printErr: whisperPrint, // Redirect errors to the same handler for now
    setStatus: function(text) {
        // Filter out or reformat common Emscripten/Wasm status messages
        if (text.includes("Downloading data...")) {
            // This is handled by cbProgress
        } else if (text.includes("prepare time") || text.includes("load time")) {
            // These are model loading time details, can be logged if needed
            console.log("Whisper status: " + text);
        } else if (text) {
            // setStatus("Whisper: " + text.substring(0,100) + "...");
            console.log("Module.setStatus: " + text);
        }
    },
    monitorRunDependencies: function(left) {
        // console.log("monitorRunDependencies:", left);
    }
};

// Helper function from whisper.wasm example
function convertTypedArray(src, type) {
    var buffer = new ArrayBuffer(src.byteLength);
    var baseView = new src.constructor(buffer).set(src);
    return new type(buffer);
}

// Function to store model in WASM FS and update UI
function storeFS(fname, buf) {
    try {
        window.Module.FS_unlink(fname);
    } catch (e) {
        // Ignore if file doesn't exist
    }
    window.Module.FS_createDataFile("/", fname, buf, true, true);
    model_whisper = fname; // Storing the actual filename used in VFS
    document.getElementById('model-whisper-status').innerHTML = `Loaded: ${model_name_ggml} (as ${fname})`;
    setStatus(`Model ${model_name_ggml} loaded.`);
    console.log('storeFS: stored model: ' + fname + ' (original: ' + model_name_ggml + ') size: ' + buf.length);

    // Hide model buttons, show loaded model name
    const modelButtons = ['fetch-whisper-tiny-en', 'fetch-whisper-tiny', 'fetch-whisper-base-en', 'fetch-whisper-base', 'fetch-whisper-tiny-en-q5_1', 'fetch-whisper-tiny-q5_1', 'fetch-whisper-base-en-q5_1', 'fetch-whisper-base-q5_1'];
    modelButtons.forEach(id => {
        const btn = document.getElementById(id);
        if(btn) btn.style.display = 'none';
    });
    document.getElementById('whisper-file').style.display = 'none';
    document.getElementById('model-whisper-status').innerHTML = 'Model: ' + model_name_ggml;
}

// Function to load a model file selected by user
window.loadFile = function(event, fname) {
    var file = event.target.files[0] || null;
    if (file == null) return;

    model_name_ggml = file.name; // Store the original model name for display
    setStatus(`Loading model: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    console.log("loadFile: loading model: " + file.name + ", size: " + file.size + " bytes. Please wait...");

    var reader = new FileReader();
    reader.onload = function(e) {
        var buf = new Uint8Array(e.target.result);
        storeFS(fname, buf); // fname is 'whisper.bin'
    }
    reader.readAsArrayBuffer(file);
}

// Callback for fetch progress
window.cbProgress = function(p) {
    let el = document.getElementById('fetch-whisper-progress');
    if (el) {
        el.innerHTML = `${model_name_ggml}: ` + Math.round(100 * p) + '%';
    }
}

// Callback for fetch cancellation
window.cbCancel = function() {
    const modelButtons = ['fetch-whisper-tiny-en', 'fetch-whisper-tiny', 'fetch-whisper-base-en', 'fetch-whisper-base', 'fetch-whisper-tiny-en-q5_1', 'fetch-whisper-tiny-q5_1', 'fetch-whisper-base-en-q5_1', 'fetch-whisper-base-q5_1'];
    modelButtons.forEach(id => {
        const btn = document.getElementById(id);
        if(btn) btn.style.display = 'inline-block';
    });
    document.getElementById('whisper-file').style.display = 'inline-block';
    document.getElementById('model-whisper-status').innerHTML = 'Not loaded';
    document.getElementById('fetch-whisper-progress').innerHTML = '';
    setStatus("Model loading cancelled or failed.");
}

// Load a remote model
window.loadWhisper = function(model) {
    // These URLs should ideally point to your own server or a reliable CDN where you host the models.
    // Using ggerganov's URLs directly might be subject to rate limits or changes.
    let urls = {
        'tiny.en':  'https://whisper.ggerganov.com/ggml-model-whisper-tiny.en.bin',
        'tiny':     'https://whisper.ggerganov.com/ggml-model-whisper-tiny.bin',
        'base.en':  'https://whisper.ggerganov.com/ggml-model-whisper-base.en.bin',
        'base':     'https://whisper.ggerganov.com/ggml-model-whisper-base.bin',
        'tiny-en-q5_1':  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin',
        'tiny-q5_1':     'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin',
        'base-en-q5_1':  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin',
        'base-q5_1':     'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
    };

    let sizes = { // in MB
        'tiny.en':  75, 'tiny': 75, 'base.en':  142, 'base': 142,
        'tiny-en-q5_1': 31, 'tiny-q5_1': 31, 'base-en-q5_1': 57, 'base-q5_1': 57,
    };

    if (!urls[model]) {
        console.error("Model " + model + " not found in URL list.");
        setStatus("Error: Model " + model + " configuration not found.");
        return;
    }

    let url     = urls[model];
    let dst     = 'whisper.bin'; // Target filename in WASM virtual file system
    let size_mb = sizes[model];

    model_name_ggml = model; // Store the friendly model name for UI updates

    setStatus(`Fetching model: ${model} (${size_mb} MB)`);
    console.log(`Loading model: ${model} from ${url}`);

    // Hide buttons during fetch
    const modelButtons = ['fetch-whisper-tiny-en', 'fetch-whisper-tiny', 'fetch-whisper-base-en', 'fetch-whisper-base', 'fetch-whisper-tiny-en-q5_1', 'fetch-whisper-tiny-q5_1', 'fetch-whisper-base-en-q5_1', 'fetch-whisper-base-q5_1'];
    modelButtons.forEach(id => {
        const btn = document.getElementById(id);
        if(btn) btn.style.display = 'none';
    });
    document.getElementById('whisper-file').style.display = 'none';
    document.getElementById('model-whisper-status').innerHTML = `Loading: ${model}...`;
    document.getElementById('fetch-whisper-progress').innerHTML = `${model}: 0%`;

    loadRemote(url, dst, size_mb, cbProgress, storeFS, cbCancel, whisperPrint);
}


// loadRemote (from helpers.js, adapted to use global whisperPrint and status functions)
function loadRemote(url, dst, size_mb, cbProgress, cbReady, cbCancel, cbPrint) {
    if (!indexedDB) {
        cbPrint("IndexedDB not supported. Model caching disabled.");
        // Fallback to direct fetch without caching if necessary, or error out
        // For simplicity, we'll rely on IndexedDB for now.
        fetchRemote(url, cbProgress, cbPrint).then(data => {
            if (data) {
                cbReady(dst, data);
            } else {
                cbCancel();
            }
        });
        return;
    }

    if (!navigator.storage || !navigator.storage.estimate) {
        cbPrint('navigator.storage.estimate() is not supported');
    } else {
        navigator.storage.estimate().then(function (estimate) {
            cbPrint('Storage quota: ' + estimate.quota + ' bytes, Usage: ' + estimate.usage + ' bytes');
        });
    }

    var rq = indexedDB.open(dbName, dbVersion);

    rq.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains('models')) {
            db.createObjectStore('models', { autoIncrement: false });
            cbPrint('Created IndexedDB ' + db.name + ' version ' + db.version + " with 'models' store.");
        }
    };

    rq.onsuccess = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains('models')) {
            cbPrint("Error: 'models' object store not found after DB open. DB version: " + db.version);
            //This might happen if onupgradeneeded didn't fire as expected (e.g. version didn't change)
            //Attempt a re-open or manual creation if robust error handling is needed
            cbCancel();
            return;
        }
        var tx = db.transaction(['models'], 'readonly');
        var os = tx.objectStore('models');
        var getRq = os.get(url);

        getRq.onsuccess = function (event) {
            if (getRq.result) {
                cbPrint('"' + url + '" found in IndexedDB. Loading from cache.');
                cbReady(dst, getRq.result);
            } else {
                cbPrint('"' + url + '" not in IndexedDB. Attempting to fetch...');
                if (!confirm(
                    'Download ' + size_mb + ' MB model: ' + model_name_ggml + '?\n' +
                    'Cached in browser for future use.')) {
                    cbCancel();
                    db.close();
                    return;
                }
                fetchRemote(url, cbProgress, cbPrint).then(function (data) {
                    if (data) {
                        var putTx = db.transaction(['models'], 'readwrite');
                        var putOs = putTx.objectStore('models');
                        try {
                            var putRq = putOs.put(data, url);
                            putRq.onsuccess = function (event) {
                                cbPrint('"' + url + '" stored in IndexedDB.');
                                cbReady(dst, data);
                            };
                            putRq.onerror = function (event) {
                                cbPrint('Failed to store "' + url + '" in IndexedDB: ' + event.target.error);
                                cbCancel();
                            };
                        } catch (e) {
                            cbPrint('Error storing "' + url + '" in IndexedDB: ' + e);
                            cbCancel();
                        } finally {
                            putTx.oncomplete = () => db.close();
                        }
                    } else {
                         cbCancel(); // fetchRemote failed
                         db.close();
                    }
                }).catch(err => {
                    cbPrint("FetchRemote error: " + err);
                    cbCancel();
                    db.close();
                });
            }
        };
        getRq.onerror = function (event) {
            cbPrint('Failed to get data from IndexedDB: ' + event.target.error);
            cbCancel();
            db.close();
        };
         tx.oncomplete = () => { if (getRq.result === undefined) { /* only close if not already closed by putTx */ } else { db.close(); } };
         tx.onerror = () => db.close(); // Ensure DB is closed on tx error
    };
    rq.onerror = function (event) {
        cbPrint('Failed to open IndexedDB: ' + event.target.error);
        cbCancel();
    };
}

// fetchRemote (from helpers.js)
async function fetchRemote(url, cbProgress, cbPrint) {
    cbPrint(`Downloading ${model_name_ggml} with fetch()...`);
    const response = await fetch(url, { method: 'GET' });

    if (!response.ok) {
        cbPrint(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
        return undefined;
    }

    const contentLength = response.headers.get('content-length');
    const total = parseInt(contentLength, 10);
    const reader = response.body.getReader();

    var chunks = [];
    var receivedLength = 0;
    var progressLast = -1;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        if (contentLength) {
            cbProgress(receivedLength / total);
            var progressCur = Math.round((receivedLength / total) * 10);
            if (progressCur != progressLast) {
                // cbPrint(`Fetching ${model_name_ggml}: ${10 * progressCur}% ...`); // Too verbose for setStatus
                progressLast = progressCur;
            }
        }
    }

    var position = 0;
    var chunksAll = new Uint8Array(receivedLength);
    for (var chunk of chunks) {
        chunksAll.set(chunk, position);
        position += chunk.length;
    }
    return chunksAll;
}

// Automatically load a default model (e.g., tiny.en quantized)
// window.addEventListener('load', () => {
//    loadWhisper('tiny-en-q5_1');
// });

// Processes the collected audio buffers using Whisper
function processCollectedAudio() {
    if (currentAudioBuffer.length === 0) {
        console.log("No audio collected, skipping transcription.");
        return;
    }

    if (!model_whisper) {
        setStatus("Whisper model not loaded. Please select and load a model.");
        console.warn("Whisper model not loaded.");
        currentAudioBuffer = []; // Clear buffer even if not processed
        return;
    }

    // Initialize Whisper instance if not already done (lazy initialization)
    if (!window.instance) {
        setStatus("Initializing Whisper instance...");
        console.log("Initializing Whisper instance with model: " + model_whisper);
        window.instance = Module.init(model_whisper); // model_whisper is 'whisper.bin'
        if (window.instance) {
            setStatus("Whisper initialized. Ready to transcribe.");
            console.log("Whisper instance initialized: ", window.instance);
        } else {
            setStatus("Error initializing Whisper. Please reload model or refresh.");
            console.error("Failed to initialize Whisper instance.");
            currentAudioBuffer = [];
            return;
        }
    }

    // Concatenate all Float32Array chunks
    let totalLength = 0;
    currentAudioBuffer.forEach(chunk => totalLength += chunk.length);
    const combinedAudio = new Float32Array(totalLength);
    let offset = 0;
    currentAudioBuffer.forEach(chunk => {
        combinedAudio.set(chunk, offset);
        offset += chunk.length;
    });
    currentAudioBuffer = []; // Clear buffer for next speech input

    console.log(`Processing ${combinedAudio.length / WHISPER_SAMPLE_RATE}s of audio.`);
    setStatus("Transcribing with Whisper...");

    const lang = document.getElementById('language').value;
    const nthreads = parseInt(document.getElementById('threads').value, 10);
    const translate = false; // We want transcription, not translation

    setTimeout(() => { // Run whisper in a timeout to allow UI to update
        try {
            const ret = Module.full_default(window.instance, combinedAudio, lang, nthreads, translate);
            console.log('Whisper full_default call returned: ' + ret);
            if (ret !== 0) {
                setStatus("Whisper transcription error code: " + ret);
                console.error("Whisper full_default failed with code: " + ret);
                 // Re-enable listening or provide error feedback
                setStatus('Error during transcription. Listening...');
            }
            // Transcription result is handled by whisperPrint (Module.print)
        } catch (e) {
            console.error("Error during Whisper transcription:", e);
            setStatus("Exception during transcription. Listening...");
        }
    }, 10); // Small delay to ensure setStatus update is rendered
}

// -----------------------------------------------------------------------------
