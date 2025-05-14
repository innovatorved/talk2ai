import microphoneStream from 'https://cdn.jsdelivr.net/npm/microphone-stream@6.0.1/+esm';
const MicrophoneStream = microphoneStream.default;

export async function stt(socket) {
	const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	var speechEvents = window.hark(stream, {
		// audioContext: PASS AN AUDIO CONTEXT
	});

	const micStream = new MicrophoneStream({
		objectMode: true,
		// context: PASS AN AUDIO CONTEXT!
	});

	micStream.setStream(stream);

	micStream.pauseRecording();
	micStream.on('data', (chunk) => {
		socket.send(JSON.stringify(chunk));
		console.log(chunk);
	});
	speechEvents.on('speaking', function () {
		console.log('speaking');
		micStream.playRecording();
	});

	speechEvents.on('stopped_speaking', function () {
		console.log('stopped_speaking');
		micStream.pauseRecording();
	});
}
