export function wav2AudioBuff(wav, callBack) {
	const audioContext = new AudioContext();
	const fileReader = new FileReader();

	fileReader.onloadend = () => {
		const arrayBuffer = fileReader.result;
		audioContext.decodeAudioData(arrayBuffer, (audioBuffer) => {
			callBack(audioBuffer);
		});
	};
	fileReader.readAsArrayBuffer(wav);
}
