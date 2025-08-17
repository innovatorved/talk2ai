export async function bufferText(
	textStream: ReadableStream<string>,
	callBack: (sentence: string) => Promise<void> | void,
	idleMs: number = 1000
) {
	let wordBuffer = '';
	let timeoutId: number | undefined;

	const flush = async () => {
		if (!wordBuffer) return;
		const toSend = wordBuffer.trim();
		wordBuffer = '';
		if (toSend) {
			await callBack(toSend);
		}
	};

	for await (const word of (textStream as any)) {
		if (timeoutId) clearTimeout(timeoutId);
		wordBuffer += String(word);

		// Match sentences ending with ., !, or ? followed by a space or end of string
		const sentenceRegex = /([^\r\n.?!]*[.?!])(\s|$)/g;
		let match: RegExpExecArray | null;
		let lastIndex = 0;

		while ((match = sentenceRegex.exec(wordBuffer)) !== null) {
			const sentence = wordBuffer.slice(lastIndex, sentenceRegex.lastIndex).trim();
			if (sentence) await callBack(sentence);
			lastIndex = sentenceRegex.lastIndex;
		}

		// Keep only the unfinished part in the wordBuffer
		wordBuffer = wordBuffer.slice(lastIndex);

		// Set a timer to process last buffer if no new word comes
		timeoutId = setTimeout(() => {
			// fire and forget; final flush at stream close will await
			void flush();
		}, idleMs) as unknown as number;
	}

	if (timeoutId) clearTimeout(timeoutId);
	await flush();
}
