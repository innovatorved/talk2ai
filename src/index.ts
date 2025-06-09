import { smoothStream, streamText } from 'ai';
import { bufferText } from './utils';
import { DurableObject } from 'cloudflare:workers';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createClient } from '@deepgram/sdk';

import PQueue from 'p-queue';

// Helper function to convert stream to audio buffer
async function getAudioBuffer(stream: ReadableStream): Promise<Buffer> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}

	const dataArray = chunks.reduce(
		(acc, chunk) => Uint8Array.from([...acc, ...chunk]),
		new Uint8Array(0)
	);

	return Buffer.from(dataArray.buffer);
}

/* Todo
 * ✅ 1. WS with frontend
 * ✅ 2. Get audio to backend
 * ✅ 3. Convert audio to text (using Deepgram Nova)
 * ✅ 4. Run inference
 * ✅ 5. Convert result to audio (using Deepgram Aura)
 * ✅ 6. Send audio to frontend
 */

export class MyDurableObject extends DurableObject {
	env: Env;
	msgHistory: Array<Object>;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.msgHistory = [];
	}
	async fetch(request: any) {
		// set up ws pipeline
		const webSocketPair = new WebSocketPair();
		const [socket, ws] = Object.values(webSocketPair);

		ws.accept();
		const queue = new PQueue({ concurrency: 1 });
		const google = createGoogleGenerativeAI({
			apiKey: this.env.GOOGLE_GENERATIVE_AI_API_KEY,
		});

		// Initialize Deepgram client
		const deepgram = createClient(this.env.DEEPGRAM_API_KEY);

		ws.addEventListener('message', async (event) => {
			// handle chat commands
			if (typeof event.data === 'string') {
				const { type, data } = JSON.parse(event.data);
				if (type === 'cmd' && data === 'clear') {
					this.msgHistory.length = 0; // clear chat history
				}
				return; // end processing here for this event type
			}

			// transcribe audio buffer to text (stt) using Deepgram Nova
			const { result: transcriptionResult, error } = await deepgram.listen.prerecorded.transcribeFile(
				// Convert ArrayBuffer to Buffer for Deepgram
				Buffer.from(event.data as ArrayBuffer),
				{
					model: 'nova-3',
					smart_format: true,
					language: 'en',
				}
			);

			if (error) {
				console.error('Deepgram transcription error:', error);
				return;
			}

			const text = transcriptionResult?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
			console.log('>>', text);
			ws.send(JSON.stringify({ type: 'text', text })); // send transcription to client
			this.msgHistory.push({ role: 'user', content: text });

			// run inference
			const result = streamText({
				model: google('gemini-2.0-flash-lite'),
				system: 'You in a voice conversation with the user',
				messages: this.msgHistory as any,
				experimental_transform: smoothStream(),
			});
			// buffer streamed response into sentences, then convert to audio
			await bufferText(result.textStream, async (sentence: string) => {
				this.msgHistory.push({ role: 'assistant', content: sentence });
				console.log('<<', sentence);
				await queue.add(async () => {
					// convert response to audio (tts) using Deepgram Aura
					const response = await deepgram.speak.request(
						{ text: sentence },
						{
							model: 'aura-asteria-en',
							encoding: 'linear16',
							container: 'wav',
						}
					);
					
					const stream = await response.getStream();
					if (stream) {
						// Convert the stream to an audio buffer
						const audioBuffer = await getAudioBuffer(stream);
						// Convert buffer to base64 for WebSocket transmission
						const audioBase64 = audioBuffer.toString('base64');
						ws.send(JSON.stringify({ type: 'audio', text: sentence, audio: audioBase64 }));
					} else {
						console.error('Error generating audio with Deepgram Aura');
					}
				});
			});
		});

		ws.addEventListener('close', (cls) => {
			ws.close(cls.code, 'Durable Object is closing WebSocket');
		});

		return new Response(null, { status: 101, webSocket: socket });
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.url.endsWith('/websocket')) {
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				return new Response('Expected upgrade to websocket', { status: 426 });
			}
			let id: DurableObjectId = env.MY_DURABLE_OBJECT.idFromName(crypto.randomUUID());
			let stub = env.MY_DURABLE_OBJECT.get(id);
			return stub.fetch(request);
		}

		return new Response(null, {
			status: 400,
			statusText: 'Bad Request',
			headers: { 'Content-Type': 'text/plain' },
		});
	},
} satisfies ExportedHandler<Env>;
