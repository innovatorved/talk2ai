import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

// Constants for loadRemote (for Whisper model caching)
const dbName = 'whisper-models-cache';
const dbVersion = 1;

export function base64ToArrBuff(base64Str) {
	return Uint8Array.from(atob(base64Str), (c) => c.charCodeAt(0)).buffer;
}

const sounds = [];
let timeOutId = null;
let isSpeaking = false;
const playingSources = [];
const audioCtx = new AudioContext();
// handles playing audio queue
// implemented as functions because class implementation gets cleaned
// prematurely
export function queueSound(sound, setStatus) {
	sounds.push(sound);
	playNext(setStatus);
}

export function stopPlaying() {
	playingSources.forEach((source) => {
		try {
			source.stop();
		} catch (e) {
			console.error('Error stopping source:', e);
		}
		sounds.splice(0, sounds.length);
		if (timeOutId) clearTimeout(timeOutId);
	});
}

function playNext(setStatus) {
	if (!isSpeaking && sounds?.length > 0) {
		isSpeaking = true;
		setStatus('AI Speaking...');
		const arrayBuff = base64ToArrBuff(sounds.shift());
		arraybufferToAudiobuffer(arrayBuff, audioCtx).then((audioBuffer) => {
			const source = audioCtx.createBufferSource();
			source.buffer = audioBuffer;
			source.connect(audioCtx.destination);
			source.start();
			playingSources.push(source);
			source.onended = () => {
				isSpeaking = false;
				setStatus('Listening...');
			};
		});
	} else {
		timeOutId = setTimeout(() => playNext(setStatus), 1000);
	}
}

// Helper functions moved from whisper.wasm/helpers.js
export function convertTypedArray(src, type) {
    var buffer = new ArrayBuffer(src.byteLength);
    var baseView = new src.constructor(buffer).set(src);
    return new type(buffer);
}

// fetch a remote file from remote URL using the Fetch API
export async function fetchRemote(url, cbProgress, cbPrint) {
    cbPrint('fetchRemote: downloading with fetch()...');

    const response = await fetch(
        url,
        {
            method: 'GET',
        }
    );

    if (!response.ok) {
        cbPrint('fetchRemote: failed to fetch ' + url);
        return;
    }

    const contentLength = response.headers.get('content-length');
    const total = parseInt(contentLength, 10);
    const reader = response.body.getReader();

    var chunks = [];
    var receivedLength = 0;
    var progressLast = -1;

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        chunks.push(value);
        receivedLength += value.length;

        if (contentLength) {
            cbProgress(receivedLength/total);

            var progressCur = Math.round((receivedLength / total) * 10);
            if (progressCur != progressLast) {
                cbPrint('fetchRemote: fetching ' + 10*progressCur + '% ...');
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

// load remote data
// - check if the data is already in the IndexedDB
// - if not, fetch it from the remote URL and store it in the IndexedDB
export function loadRemote(url, dst, size_mb, cbProgress, cbReady, cbCancel, cbPrint) {
    if (!navigator.storage || !navigator.storage.estimate) {
        cbPrint('loadRemote: navigator.storage.estimate() is not supported');
    } else {
        // query the storage quota and print it
        navigator.storage.estimate().then(function (estimate) {
            cbPrint('loadRemote: storage quota: ' + estimate.quota + ' bytes');
            cbPrint('loadRemote: storage usage: ' + estimate.usage + ' bytes');
        });
    }

		const indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
		if (!indexedDB) {
			cbPrint('loadRemote: IndexedDB is not supported.');
			// Fallback to just fetching without caching if IndexedDB is not available
			fetchRemote(url, cbProgress, cbPrint).then(function (data) {
				if (data) {
					cbReady(dst, data);
				} else {
					cbCancel();
				}
			}).catch(err => {
				cbPrint('loadRemote: fetchRemote (no IndexedDB) failed: ' + err);
				cbCancel();
			});
			return;
		}

    // check if the data is already in the IndexedDB
    var rq = indexedDB.open(dbName, dbVersion);

    rq.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (db.version == 1) { // Check against the specific version we are upgrading to
            if (!db.objectStoreNames.contains('models')) {
                var os = db.createObjectStore('models', { autoIncrement: false });
                cbPrint('loadRemote: created IndexedDB object store "models" in ' + db.name + ' version ' + db.version);
            }
        } else {
            // This case might indicate a more complex upgrade path not handled here
            // For simplicity, we'll assume version 1 or a fresh DB.
            // If an older version existed and an upgrade was needed but not to version 1,
            // this might need more sophisticated handling.
            // However, the original script only creates version 1.
             if (db.objectStoreNames.contains('models')) {
                var os = event.currentTarget.transaction.objectStore('models');
                os.clear(); // Clear old store if it exists and version is different
                cbPrint('loadRemote: cleared existing IndexedDB object store "models" during upgrade in ' + db.name);
             } else {
                db.createObjectStore('models', { autoIncrement: false });
                cbPrint('loadRemote: created IndexedDB object store "models" during upgrade in ' + db.name);
             }
        }
    };

    rq.onsuccess = function (event) {
        var db = event.target.result;
				// Ensure 'models' store exists before trying to use it
				if (!db.objectStoreNames.contains('models')) {
					cbPrint('loadRemote: "models" object store not found. Attempting to fetch without cache.');
					fetchRemote(url, cbProgress, cbPrint).then(function (data) {
						if (data) {
							cbReady(dst, data);
						} else {
							cbCancel();
						}
					}).catch(err => {
						cbPrint('loadRemote: fetchRemote (after DB issue) failed: ' + err);
						cbCancel();
					});
					return;
				}

        var tx = db.transaction(['models'], 'readonly');
        var os = tx.objectStore('models');
        var getRq = os.get(url); // Renamed to avoid conflict with outer 'rq'

        getRq.onsuccess = function (event) {
            if (getRq.result) {
                cbPrint('loadRemote: "' + url + '" is already in the IndexedDB');
                cbReady(dst, getRq.result);
            } else {
                // data is not in the IndexedDB
                cbPrint('loadRemote: "' + url + '" is not in the IndexedDB');

                // alert and ask the user to confirm
                if (!confirm(
                    'You are about to download ' + size_mb + ' MB of data.\n' +
                    'The model data will be cached in the browser for future use.\n\n' +
                    'Press OK to continue.')) {
                    cbCancel();
                    return;
                }

                fetchRemote(url, cbProgress, cbPrint).then(function (data) {
                    if (data) {
                        // store the data in the IndexedDB
                        var putRqOpen = indexedDB.open(dbName, dbVersion); // Re-open DB for readwrite transaction
                        putRqOpen.onsuccess = function (event) {
                            var dbPut = event.target.result;
														if (!dbPut.objectStoreNames.contains('models')) {
															cbPrint('loadRemote: "models" object store disappeared before put. This is unexpected.');
															cbCancel();
															return;
														}
                            var txPut = dbPut.transaction(['models'], 'readwrite');
                            var osPut = txPut.objectStore('models');
                            var putRq = null;
                            try {
                                putRq = osPut.put(data, url);
                            } catch (e) {
                                cbPrint('loadRemote: failed to store "' + url + '" in the IndexedDB: \n' + e);
                                cbCancel();
                                return;
                            }

                            putRq.onsuccess = function (event) {
                                cbPrint('loadRemote: "' + url + '" stored in the IndexedDB');
                                cbReady(dst, data);
                            };

                            putRq.onerror = function (event) {
                                cbPrint('loadRemote: failed to store "' + url + '" in the IndexedDB. Error: ' + putRq.error);
                                cbCancel();
                            };
                        };
												putRqOpen.onerror = function(event) {
													cbPrint('loadRemote: failed to re-open DB for writing.');
													cbCancel();
												};
                    } else {
											cbPrint('loadRemote: fetchRemote returned no data.');
											cbCancel();
										}
                }).catch(err => {
									cbPrint('loadRemote: fetchRemote failed: ' + err);
									cbCancel();
								});
            }
        };

        getRq.onerror = function (event) {
            cbPrint('loadRemote: failed to get data from the IndexedDB. Error: ' + getRq.error);
            cbCancel();
        };
    };

    rq.onerror = function (event) {
        cbPrint('loadRemote: failed to open IndexedDB. Error: ' + rq.error);
        cbCancel();
    };

    rq.onblocked = function (event) {
        cbPrint('loadRemote: failed to open IndexedDB: blocked');
        cbCancel();
    };

    // rq.onabort is not a standard IDBOpenDBRequest event, removing.
    // rq.onabort = function (event) {
    //     cbPrint('loadRemote: failed to open IndexedDB: abort');
    //     cbCancel();
    // };
}
