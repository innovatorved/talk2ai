import { vad } from './vad/index.js';
import { base64ToArrBuff, queueSound, stopPlaying } from './utils.js';
import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

// Whisper.wasm related global variables
window.instance = null;
window.model_whisper = ''; // Name of the loaded model, VFS path e.g. 'whisper.bin'
let isWasmRuntimeInitialized = false;
let queuedFileOperations = []; // To store { operation: 'store', fname, buf, originalModelName } or { operation: 'init_instance', modelPath }
let modelReadyForInstanceInit = false;
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
		console.log('WebSocket: Already open or connecting.');
		return;
	}
	console.log('WebSocket: Attempting to connect...');
	socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/websocket`);

	socket.onopen = () => {
		console.log('WebSocket: Connection opened.');
		setStatus(vadInitialized ? 'Listening...' : 'Ready to initialize VAD.');
	};

	socket.onmessage = async (event) => {
		console.log("WebSocket: Message received from server:", event.data);
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
		console.error('WebSocket: Error:', error);
		setStatus('Connection error. Try refreshing.');
	};

	socket.onclose = (event) => {
		console.log('WebSocket: Connection closed. Reason:', event.reason, "Code:", event.code);
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
        console.log("VAD: Audio buffer received, length:", buff.length);
        if (buff.length > 0) {
            currentAudioBuffer.push(buff);
            console.log("VAD: Pushing audio chunk to currentAudioBuffer. currentAudioBuffer length now:", currentAudioBuffer.length);
        }
	}

	// Handles VAD status changes, triggers transcription on speech end
	function onVADStatus(status) {
        console.log("VAD: Status changed to:", status);
		if (conversationActive) setStatus(`VAD: ${status}`);
		// Trigger transcription when VAD detects end of speech (e.g., "INACTIVE" or "SILENCE" after "VOICE")
        if (window.vadState === "VOICE" && (status === "SILENCE" || status === "INACTIVE")) {
            console.log("VAD: End of speech detected. Calling processCollectedAudio.");
            processCollectedAudio();
        }
        window.vadState = status; // Store current VAD state
	}

	try {
        console.log("VAD: Initializing with sample rate", WHISPER_SAMPLE_RATE + "...");
		await vad(onAudioBuffer, onVADStatus, WHISPER_SAMPLE_RATE); // Initialize VAD
		vadInitialized = true;
		console.log('VAD: Initialized successfully.');
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
    console.log("WhisperModuleOutput:", text);
    if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
    // console.log("Whisper output: " + text); // Redundant with the above

    const isLikelyStatus = text.startsWith('[') || text.startsWith('whisper_') || text.includes('progress =') || text.includes('time =') || text.startsWith('js: ') || text.startsWith('main: ');

    if (isLikelyStatus) {
        console.log("WhisperModuleOutput: Detected as status/progress message.");
        // setStatus("Whisper: " + text.substring(0, 70) + "...");
    } else if (text.trim().length > 0 && window.instance) {
        const transcribedText = text.trim();
        console.log("WhisperModuleOutput: Detected as transcription. Text:", transcribedText);

        console.log("WhisperModuleOutput: Displaying in UI:", transcribedText);
        printSpeach(transcribedText, 'user');

        if (socket && socket.readyState === WebSocket.OPEN) {
            console.log("WhisperModuleOutput: Sending to WebSocket:", transcribedText);
            socket.send(JSON.stringify({ type: 'text', text: transcribedText }));
        } else {
            console.warn('WhisperModuleOutput: WebSocket not open, cannot send.');
            setStatus('Connection issue. Cannot send transcription.');
        }
        setStatus('Listening...'); // Reset status after transcription
    }
}

window.Module = {
    print: whisperPrint,
    printErr: whisperPrint, // Redirect errors to the same handler for now
    onRuntimeInitialized: function() {
        console.error("WASM RUNTIME INITIALIZED: Module.onRuntimeInitialized has been CALLED!"); // Use console.error for visibility
        isWasmRuntimeInitialized = true;
        let instanceInitQueued = false;
        let modelPathForQueuedInit = null;

        queuedFileOperations.forEach(op => {
            if (op.operation === 'store') {
                console.log(`WASM Runtime: Processing queued 'store' for ${op.fname} (original: ${op.originalModelName})`);
                if (window.Module.FS_unlink && window.Module.FS_createDataFile) {
                    try { window.Module.FS_unlink(op.fname); } catch (e) { /* ignore */ }
                    window.Module.FS_createDataFile("/", op.fname, op.buf, true, true);

                    model_whisper = op.fname; // This is 'whisper.bin'
                    model_name_ggml = op.originalModelName; // Restore the user-facing name

                    document.getElementById('model-whisper-status').innerHTML = `Model: ${model_name_ggml} (Loaded to VFS)`;
                    setStatus(`Model ${model_name_ggml} ready in WASM FS.`);
                    console.log('storeFS (deferred): stored model: ' + op.fname + ' (original: ' + model_name_ggml + ') size: ' + op.buf.length);

                    modelReadyForInstanceInit = true;
                    console.log("WASM Runtime: Model", op.fname, "is now in VFS. modelReadyForInstanceInit = true");

                    const modelButtons = ['fetch-whisper-tiny-en', 'fetch-whisper-tiny', 'fetch-whisper-base-en', 'fetch-whisper-base', 'fetch-whisper-tiny-en-q5_1', 'fetch-whisper-tiny-q5_1', 'fetch-whisper-base-en-q5_1', 'fetch-whisper-base-q5_1'];
                    modelButtons.forEach(id => {
                        const btn = document.getElementById(id);
                        if(btn) btn.style.display = 'none';
                    });
                    if(document.getElementById('whisper-file')) document.getElementById('whisper-file').style.display = 'none';

                } else {
                    console.error("WASM Runtime: Error - FS methods not available in onRuntimeInitialized for 'store'.");
                    setStatus("Error: Could not save model to WASM FS.");
                    modelReadyForInstanceInit = false;
                }
            } else if (op.operation === 'init_instance') {
                instanceInitQueued = true;
                modelPathForQueuedInit = op.modelPath;
            }
        });

        if (instanceInitQueued && modelReadyForInstanceInit) {
            console.log("WASM Runtime: Processing queued 'init_instance'. model_whisper (VFS path for Module.init):", modelPathForQueuedInit);
            if (window.Module.init) {
                window.instance = Module.init(modelPathForQueuedInit);
                if (window.instance) {
                    setStatus("Whisper initialized (deferred). Ready to transcribe.");
                    console.log("WASM Runtime: Queued instance init for", modelPathForQueuedInit, "completed. Instance:", window.instance);
                } else {
                    setStatus("Error initializing Whisper (deferred from queue).");
                    console.error("WASM Runtime: Failed to initialize Whisper instance (deferred from queue).");
                }
            } else {
                 console.error("WASM Runtime: Module.init not available for queued 'init_instance'.");
            }
        } else if (instanceInitQueued && !modelReadyForInstanceInit) {
            console.warn("WASM Runtime: Instance init was queued, but model is not ready in VFS. User might need to re-initiate action.");
            setStatus("Model loaded, but Whisper engine init pending. Try starting conversation again.");
        }

        queuedFileOperations = [];
        console.log("WASM Runtime: Finished processing all queued operations in onRuntimeInitialized.");
        if (!window.instance && instanceInitQueued && !modelReadyForInstanceInit) {
            console.error("WASM Runtime: Instance initialization was queued but model was not ready. Transcription will likely fail until model is reloaded or this is resolved.");
        } else if (!window.instance && instanceInitQueued && modelReadyForInstanceInit) {
            console.error("WASM Runtime: Instance initialization was queued and model was ready, but Module.init might have failed silently or instance not set.");
        } else if (window.instance) {
            console.log("WASM Runtime: Whisper instance should now be initialized:", window.instance);
        }
    },
    setStatus: function(text) {
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
function storeFS(fname, buf) { // fname is 'whisper.bin', model_name_ggml is the display name like 'base.en'
    if (isWasmRuntimeInitialized && window.Module && window.Module.FS_createDataFile && window.Module.FS_unlink) {
        console.log(`storeFS: Runtime initialized. Storing ${fname} (original: ${model_name_ggml}) directly.`);
        try { window.Module.FS_unlink(fname); } catch (e) { /* ignore */ }
        window.Module.FS_createDataFile("/", fname, buf, true, true);

        model_whisper = fname; // Set the VFS path
        // model_name_ggml is already set by loadWhisper/loadFile

        document.getElementById('model-whisper-status').innerHTML = `Model: ${model_name_ggml} (Loaded to VFS)`;
        setStatus(`Model ${model_name_ggml} ready in WASM FS.`);
        console.log('storeFS: stored model: ' + fname + ' (original: ' + model_name_ggml + ') size: ' + buf.length);
        modelReadyForInstanceInit = true;
        console.log("storeFS: modelReadyForInstanceInit = true");

        const modelButtons = ['fetch-whisper-tiny-en', 'fetch-whisper-tiny', 'fetch-whisper-base-en', 'fetch-whisper-base', 'fetch-whisper-tiny-en-q5_1', 'fetch-whisper-tiny-q5_1', 'fetch-whisper-base-en-q5_1', 'fetch-whisper-base-q5_1'];
        modelButtons.forEach(id => {
            const btn = document.getElementById(id);
            if(btn) btn.style.display = 'none';
        });
        if(document.getElementById('whisper-file')) document.getElementById('whisper-file').style.display = 'none';

    } else {
        console.log(`storeFS: Runtime not yet initialized. Queuing FS operation for ${fname} (original: ${model_name_ggml}).`);
        // Pass current model_name_ggml to be restored when queue is processed
        queuedFileOperations.push({ operation: 'store', fname, buf, originalModelName: model_name_ggml });
        document.getElementById('model-whisper-status').innerHTML = `Model ${model_name_ggml} downloaded, waiting for WASM FS...`;
        modelReadyForInstanceInit = false; // Not ready yet
    }
}

window.loadFile = function(event, fname) { // fname is 'whisper.bin'
    console.log("UI: loadFile called for local file. Target VFS name:", fname);
    var file = event.target.files[0] || null;
    if (file == null) return;

    model_name_ggml = file.name; // Set the display name HERE
    setStatus(`Loading model: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    console.log("loadFile: loading model: " + file.name + ", size: " + file.size + " bytes. Please wait...");

    var reader = new FileReader();
    reader.onload = function(e) {
        var buf = new Uint8Array(e.target.result);
        storeFS(fname, buf); // storeFS will use the global model_name_ggml
    }
    reader.readAsArrayBuffer(file);
}

window.cbProgress = function(p) {
    let el = document.getElementById('fetch-whisper-progress');
    const progressPercent = Math.round(100 * p);
    if (el) {
        el.innerHTML = `${model_name_ggml}: ` + progressPercent + '%';
    }
    // console.log("UI: Model fetch progress for", model_name_ggml, ":", progressPercent + '%'); // Can be too verbose
}

window.cbCancel = function() {
    // model_name_ggml should hold the name of the model that failed/was cancelled
    console.log("UI: Model load cancelled/failed for", model_name_ggml || "unknown model");
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

window.loadWhisper = function(model) {
    console.log("UI: loadWhisper called for model:", model);
    let urls = { // URLs are already pointing to Hugging Face or similar
        'tiny.en':  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
        'tiny':     'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
        'base.en':  'https://whisper.ggerganov.com/ggml-model-whisper-base.en.bin', // This one might still be original
        'base':     'https://whisper.ggerganov.com/ggml-model-whisper-base.bin',   // This one might still be original
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
    let dst     = 'whisper.bin';
    let size_mb = sizes[model];

    model_name_ggml = model; // Set the display name HERE

    setStatus(`Fetching model: ${model_name_ggml} (${size_mb} MB)`);
    console.log(`Loading model: ${model_name_ggml} from ${url}`);

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
        // cbPrint is whisperPrint, which logs to console
        whisperPrint("IndexedDB not supported. Model caching disabled.");
        fetchRemote(url, cbProgress, whisperPrint).then(data => {
            if (data) {
                // cbReady is storeFS
                console.log("UI: Model data fetched (no cache for)", url, ". Calling storeFS for", dst);
                storeFS(dst, data);
            } else {
                cbCancel();
            }
        });
        return;
    }

    if (!navigator.storage || !navigator.storage.estimate) {
        whisperPrint('navigator.storage.estimate() is not supported');
    } else {
        navigator.storage.estimate().then(function (estimate) {
            whisperPrint('Storage quota: ' + estimate.quota + ' bytes, Usage: ' + estimate.usage + ' bytes');
        });
    }

    var rq = indexedDB.open(dbName, dbVersion);

    rq.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains('models')) {
            db.createObjectStore('models', { autoIncrement: false });
            whisperPrint('Created IndexedDB ' + db.name + ' version ' + db.version + " with 'models' store.");
        }
    };

    rq.onsuccess = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains('models')) {
            whisperPrint("Error: 'models' object store not found after DB open. DB version: " + db.version);
            cbCancel();
            return;
        }
        var tx = db.transaction(['models'], 'readonly');
        var os = tx.objectStore('models');
        var getRq = os.get(url);

        getRq.onsuccess = function (event) {
            if (getRq.result) {
                whisperPrint('"' + url + '" found in IndexedDB. Loading from cache.');
                console.log("UI: Model data fetched/found in cache for", url, ". Calling storeFS for", dst);
                storeFS(dst, getRq.result); // cbReady is storeFS
            } else {
                whisperPrint('"' + url + '" not in IndexedDB. Attempting to fetch...');
                if (!confirm(
                    'Download ' + size_mb + ' MB model: ' + model_name_ggml + '?\n' +
                    'Cached in browser for future use.')) {
                    cbCancel();
                    db.close();
                    return;
                }
                fetchRemote(url, cbProgress, whisperPrint).then(function (data) {
                    if (data) {
                        var putTx = db.transaction(['models'], 'readwrite');
                        var putOs = putTx.objectStore('models');
                        try {
                            var putRq = putOs.put(data, url);
                            putRq.onsuccess = function (event) {
                                whisperPrint('"' + url + '" stored in IndexedDB.');
                                console.log("UI: Model data fetched (and stored in cache) for", url, ". Calling storeFS for", dst);
                                storeFS(dst, data); // cbReady is storeFS
                            };
                            putRq.onerror = function (event) {
                                whisperPrint('Failed to store "' + url + '" in IndexedDB: ' + event.target.error);
                                cbCancel();
                            };
                        } catch (e) {
                            whisperPrint('Error storing "' + url + '" in IndexedDB: ' + e);
                            cbCancel();
                        } finally {
                            putTx.oncomplete = () => db.close();
                        }
                    } else {
                         cbCancel();
                         db.close();
                    }
                }).catch(err => {
                    whisperPrint("FetchRemote error: " + err);
                    cbCancel();
                    db.close();
                });
            }
        };
        getRq.onerror = function (event) {
            whisperPrint('Failed to get data from IndexedDB: ' + event.target.error);
            cbCancel();
            db.close();
        };
         tx.oncomplete = () => { if (getRq.result === undefined) {} else { db.close(); } };
         tx.onerror = () => db.close();
    };
    rq.onerror = function (event) {
        whisperPrint('Failed to open IndexedDB: ' + event.target.error);
        cbCancel();
    };
}

async function fetchRemote(url, cbProgress, cbPrint) { // cbPrint is whisperPrint
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

function processCollectedAudio() {
    console.log("Whisper: processCollectedAudio called.");
    if (currentAudioBuffer.length === 0) {
        console.log("Whisper: No audio in currentAudioBuffer to process.");
        if (document.getElementById('statusText').textContent === "Transcribing with Whisper...") {
             setStatus('Listening...');
        }
        return;
    }

    if (!model_whisper) { // This should be 'whisper.bin' if a model was processed by storeFS
        setStatus("Whisper model not selected/loaded into VFS. Please select a model.");
        console.warn("Whisper: model_whisper (VFS path) is not set. Cannot process audio.");
        currentAudioBuffer = [];
        return;
    }

    console.log("Whisper: Checking conditions for instance init/use. isWasmRuntimeInitialized:", isWasmRuntimeInitialized, "modelReadyForInstanceInit:", modelReadyForInstanceInit, "window.instance:", window.instance);

    if (!window.instance) {
        if (isWasmRuntimeInitialized && modelReadyForInstanceInit && window.Module && window.Module.init) {
            setStatus("Initializing Whisper instance...");
            console.log("Whisper: processCollectedAudio - Attempting direct Module.init(). model_whisper (VFS path):", model_whisper);
            window.instance = Module.init(model_whisper);
            if (window.instance) {
                setStatus("Whisper initialized. Ready to transcribe.");
                console.log("Whisper: Instance initialized successfully:", window.instance);
            } else {
                setStatus("Error initializing Whisper. Please reload model or refresh.");
                console.error("Whisper: Failed to initialize Whisper instance with " + model_whisper);
                currentAudioBuffer = [];
                return;
            }
        } else {
            setStatus("Whisper engine not ready or model not in VFS. Queuing instance init.");
            console.log("Whisper: processCollectedAudio - Deferring Module.init(). Conditions: isWasmRuntimeInitialized:", isWasmRuntimeInitialized, "modelReadyForInstanceInit:", modelReadyForInstanceInit, "Module.init exists:", !!(window.Module && window.Module.init), "model_whisper:", model_whisper);

            if (!queuedFileOperations.find(op => op.operation === 'init_instance')) {
                 console.log("Whisper: Queuing 'init_instance' operation for model path:", model_whisper);
                 queuedFileOperations.push({ operation: 'init_instance', modelPath: model_whisper });
            } else {
                console.log("Whisper: 'init_instance' operation already in queue for model path:", model_whisper);
            }
            console.warn("Whisper: Deferring transcription, current audio buffer will be cleared.");
            setStatus("Whisper engine initializing, please try speaking again shortly.");
            currentAudioBuffer = [];
            return;
        }
    }

    let totalLength = 0;
    currentAudioBuffer.forEach(chunk => totalLength += chunk.length);
    console.log("Whisper: Preparing to process collected audio. Number of chunks:", currentAudioBuffer.length, "Total Float32 samples:", totalLength);

    if (totalLength === 0) {
        console.warn("Whisper: Combined audio buffer is empty after all checks. Skipping transcription.");
        setStatus("Listening...");
        return;
    }

    const combinedAudio = new Float32Array(totalLength);
    let offset = 0;
    currentAudioBuffer.forEach(chunk => {
        combinedAudio.set(chunk, offset);
        offset += chunk.length;
    });
    currentAudioBuffer = [];

    console.log(`Whisper: Combined audio buffer created. Length: ${combinedAudio.length}, Type: ${combinedAudio.constructor.name}, Duration: ${(combinedAudio.length / WHISPER_SAMPLE_RATE).toFixed(2)}s`);
    setStatus("Transcribing with Whisper...");

    const lang = document.getElementById('language').value;
    let nthreadsElement = document.getElementById('threads');
    let nthreads = nthreadsElement ? parseInt(nthreadsElement.value, 10) : 4;
    console.log("Whisper: Using threads from UI:", document.getElementById('threads').value, "Parsed as:", nthreads);

    const translate = false;

    console.log("Whisper: Calling full_default. Language:", lang, "Threads:", nthreads, "Translate:", translate, "Audio length (samples):", combinedAudio.length);
    setTimeout(() => {
        try {
            const ret = Module.full_default(window.instance, combinedAudio, lang, nthreads, translate);
            console.log('Whisper: full_default call returned code:', ret);
            if (ret !== 0) {
                setStatus("Whisper transcription error code: " + ret);
                console.error("Whisper: full_default failed with code: " + ret);
                setStatus('Error during transcription. Listening...');
            }
        } catch (e) {
            console.error("Whisper: Error during full_default call:", e);
            setStatus("Exception during transcription. Listening...");
        }
    }, 10);
}

// Placeholder for handleStartConversation if it's meant to be in this file
// Otherwise, it's typically in ui.js or similar.
// window.handleStartConversation = async () => {
//    console.log("UI: handleStartConversation called.");
//    const vadReady = await initializeVADSystem();
//    console.log("UI: VAD ready status:", vadReady);
//    if (vadReady) {
//        // Manage UI state (e.g., disable start, enable stop)
//    }
// };
// -----------------------------------------------------------------------------
