export async function bufferText(textStream: ReadableStream, callBack: (sentence: string) => void) {
	let buffer = '';

	for await (const textPart of textStream) {
		buffer += textPart;

		// Match sentences ending with ., !, or ? followed by a space or end of string
		const sentenceRegex = /([^\r\n.?!]*[.?!])(\s|$)/g;
		let match;
		let lastIndex = 0;

		while ((match = sentenceRegex.exec(buffer)) !== null) {
			const sentence = buffer.slice(lastIndex, sentenceRegex.lastIndex).trim();
			if (sentence) callBack(sentence);
			lastIndex = sentenceRegex.lastIndex;
		}

		// Keep only the unfinished part in the buffer
		buffer = buffer.slice(lastIndex);
	}
}
