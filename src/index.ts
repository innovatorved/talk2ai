import { smoothStream, streamText } from 'ai';
import { bufferText } from './utils';
import { DurableObject } from 'cloudflare:workers';
import { createWorkersAI } from 'workers-ai-provider';
import PQueue from 'p-queue';

/* Todo
 * ✅ 1. WS with frontend
 * ✅ 2. Get audio to backend
 * ✅ 3. Convert audio to text
 * ✅ 4. Run inference
 * ✅ 5. Convert result to audio
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
		const workersai = createWorkersAI({ binding: this.env.AI });
		const queue = new PQueue({ concurrency: 1 });

		ws.addEventListener('message', async (event) => {
			// handle chat commands
			if (typeof event.data === 'string') {
				const { type, data } = JSON.parse(event.data);
				if (type === 'cmd' && data === 'clear') {
					this.msgHistory.length = 0; // clear chat history
				}
				return; // end processing here for this event type
			}

			// transcribe audio buffer to text (stt)
			const { text } = await this.env.AI.run('@cf/openai/whisper-tiny-en', {
				audio: [...new Uint8Array(event.data as ArrayBuffer)],
			});
			console.log('>>', text);
			ws.send(JSON.stringify({ type: 'text', text })); // send transcription to client
			this.msgHistory.push({ role: 'user', content: text });

			// run inference
			const result = streamText({
				model: workersai('@cf/meta/llama-4-scout-17b-16e-instruct' as any),
				system: 'You in a voice conversation with the user',
				messages: this.msgHistory as any,
				// experimental_transform: smoothStream(),
			});
			// buffer streamed response into sentences, then convert to audio
			await bufferText(result.textStream, async (sentence: string) => {
				this.msgHistory.push({ role: 'assistant', content: sentence });
				console.log('<<', sentence);
				await queue.add(async () => {
					// convert response to audio (tts)
					const audio = await this.env.AI.run('@cf/myshell-ai/melotts' as any, {
						prompt: sentence,
						// lang: 'es'
					});
					ws.send(JSON.stringify({ type: 'audio', text: sentence, audio: audio.audio }));
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
