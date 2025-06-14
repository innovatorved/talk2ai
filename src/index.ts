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
			let userText = '';
			let fromClient = false;

			if (typeof event.data === 'string') {
				try {
					const parsedData = JSON.parse(event.data as string);
					if (parsedData.type === 'cmd' && parsedData.data === 'clear') {
						this.msgHistory.length = 0; // clear chat history
						console.log('Chat history cleared.');
						return; // end processing here for cmd:clear
					} else if (parsedData.type === 'text' && typeof parsedData.text === 'string') {
						// This is a transcription from the client (Whisper.wasm)
						userText = parsedData.text;
						fromClient = parsedData.fromClient || false; // Check if it's marked from client
						console.log('>> Received text from client:', userText);
						// Do not send this text back to the originating client if fromClient is true
					} else {
						console.warn('Received unhandled string message type or format:', parsedData);
						return;
					}
				} catch (e) {
					console.error('Failed to parse string message from client:', e);
					return; // Not a valid JSON command or text message
				}
			} else {
				// This block would have handled raw audio for Deepgram STT.
				// It's now removed as STT is client-side.
				console.log('Received binary data, but STT is now client-side. Ignoring.');
				return; // No longer processing direct audio buffers for STT
			}

			if (!userText) {
				console.log('No user text to process.');
				return;
			}

			this.msgHistory.push({ role: 'user', content: userText });

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
