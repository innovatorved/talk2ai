import { DurableObject } from 'cloudflare:workers';
import { createWorkersAI } from 'workers-ai-provider';
import { generateText, streamText } from 'ai';
import Lz from 'lz-string';
import { bufferText } from './utils';
/* Todo
 * ✅ 1. WS with frontend
 * ✅ 2. Get audio to backend
 * ✅ 3. Convert audio to text
 * 4. Run inference
 * 5. Convert result to audio
 * 6. Send audio to frontend
 */

/** A Durable Object's behavior is defined in an exported Javascript class */
export class MyDurableObject extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: any) {
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		server.accept();
		const workersai = createWorkersAI({ binding: this.env.AI });
		const model = workersai('@cf/meta/llama-3.3-70b-instruct-fp8-fast');

		server.addEventListener('message', async (event) => {
			console.log('>> ' + event.data);
			const messages = [
				{ role: 'system', content: 'You in a voice conversation' },
				{ role: 'user', content: event.data },
			];

			const { textStream } = streamText({
				model,
				messages,
			});

			await bufferText(textStream, (sentence: string) => {
				console.log('>>', sentence);
				server.send(JSON.stringify({ type: 'text', text: sentence }));
			});

			// const result = await generateText({
			// 	model,
			// 	messages,
			// });
			//
			// server.send(JSON.stringify({ type: 'text', text: result.text }));

			// const audio = await this.env.AI.run('@cf/myshell-ai/melotts', {
			// 	prompt: result.text,
			// });
			// // console.log(audio);
			// server.send(JSON.stringify({ type: 'audio', audio: Lz.compress(audio.audio) }));
		});

		server.addEventListener('close', (cls) => {
			server.close(cls.code, 'Durable Object is closing WebSocket');
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.url.endsWith('/websocket')) {
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				return new Response('Durable Object expected Upgrade: websocket', {
					status: 426,
				});
			}

			let id: DurableObjectId = env.MY_DURABLE_OBJECT.idFromName(new URL(request.url).pathname);
			let stub = env.MY_DURABLE_OBJECT.get(id);

			return stub.fetch(request);
		}

		return new Response(null, {
			status: 400,
			statusText: 'Bad Request',
			headers: {
				'Content-Type': 'text/plain',
			},
		});
	},
} satisfies ExportedHandler<Env>;
