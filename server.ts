import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import * as util from "util";
import * as url from "url";

import { Emitter } from "vs/base/common/event";
import { getMediaMime } from "vs/base/common/mime";
import { extname } from "vs/base/common/path";
import { IPCServer, ClientConnectionEvent } from "vs/base/parts/ipc/common/ipc";
import { validatePaths } from "vs/code/node/paths";
import { parseMainProcessArgv } from "vs/platform/environment/node/argvHelper";
import { ParsedArgs } from "vs/platform/environment/common/environment";
import { EnvironmentService } from "vs/platform/environment/node/environmentService";
import { InstantiationService } from "vs/platform/instantiation/common/instantiationService";
import { ConsoleLogMainService } from "vs/platform/log/common/log";
import { LogLevelSetterChannel } from "vs/platform/log/common/logIpc";
import { ConnectionType } from "vs/platform/remote/common/remoteAgentConnection";
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from "vs/platform/remote/common/remoteAgentFileSystemChannel";

import { Connection, Server as IServer } from "vs/server/connection";
import { ExtensionEnvironmentChannel, FileProviderChannel } from "vs/server/channel";
import { Socket } from "vs/server/socket";

export enum HttpCode {
	Ok = 200,
	NotFound = 404,
	BadRequest = 400,
}

export class HttpError extends Error {
	public constructor(message: string, public readonly code: number) {
		super(message);
		// @ts-ignore
		this.name = this.constructor.name;
		Error.captureStackTrace(this, this.constructor);
	}
}

export class Server implements IServer {
	// When a new client connects, it will fire this event which is used in the
	// IPC server which manages channels.
	public readonly _onDidClientConnect = new Emitter<ClientConnectionEvent>();
	public readonly onDidClientConnect = this._onDidClientConnect.event;

	private readonly rootPath = path.resolve(__dirname, "../../..");

	// This is separate instead of just extending this class since we can't
	// use properties in the super call. This manages channels.
	private readonly ipc = new IPCServer(this.onDidClientConnect);

	// The web server.
	private readonly server: http.Server;

	// Persistent connections. These can reconnect within a timeout. Individual
	// sockets will add connections made through them to this map and remove them
	// when they close.
	public readonly connections = new Map<ConnectionType, Map<string, Connection>>();

	public constructor() {
		this.server = http.createServer(async (request, response): Promise<void> => {
			try {
				const [content, headers] = await this.handleRequest(request);
				response.writeHead(HttpCode.Ok, {
					"Cache-Control": "max-age=86400",
					// TODO: ETag?
					...headers,
				});
				response.end(content);
			} catch (error) {
				response.writeHead(typeof error.code === "number" ? error.code : 500);
				response.end(error.message);
			}
		});

		this.server.on("upgrade", (request, socket) => {
			try {
				const nodeSocket = this.handleUpgrade(request, socket);
				nodeSocket.handshake(this);
			} catch (error) {
				socket.end(error.message);
			}
		});

		this.server.on("error", (error) => {
			console.error(error);
			process.exit(1);
		});

		let args: ParsedArgs;
		try {
			args = parseMainProcessArgv(process.argv);
			args = validatePaths(args);
		} catch (error) {
			console.error(error.message);
			return process.exit(1);
		}

		const environmentService = new EnvironmentService(args, process.execPath);

		// TODO: might want to use spdlog.
		const logService = new ConsoleLogMainService();
		this.ipc.registerChannel("loglevel", new LogLevelSetterChannel(logService));

		const instantiationService = new InstantiationService();
		instantiationService.invokeFunction(() => {
			this.ipc.registerChannel(
				REMOTE_FILE_SYSTEM_CHANNEL_NAME,
				new FileProviderChannel(),
			);
			this.ipc.registerChannel(
				"remoteextensionsenvironment",
				new ExtensionEnvironmentChannel(environmentService),
			);
		});
	}

	private async handleRequest(request: http.IncomingMessage): Promise<[string | Buffer, http.OutgoingHttpHeaders]> {
		if (request.method !== "GET") {
			throw new HttpError(
				`Unsupported method ${request.method}`,
				HttpCode.BadRequest,
			);
		}

		const requestPath = url.parse(request.url || "").pathname || "/";
		if (requestPath === "/") {
			const htmlPath = path.join(
				this.rootPath,
				'out/vs/code/browser/workbench/workbench.html',
			);

			let html = await util.promisify(fs.readFile)(htmlPath, "utf8");

			const options = {
				WEBVIEW_ENDPOINT: {},
				WORKBENCH_WEB_CONGIGURATION: {
					remoteAuthority: request.headers.host,
				},
				REMOTE_USER_DATA_URI: {
					scheme: "http",
					authority: request.headers.host,
					path: "/",
				},
				PRODUCT_CONFIGURATION: {},
				CONNECTION_AUTH_TOKEN: {}
			};

			Object.keys(options).forEach((key) => {
				html = html.replace(`"{{${key}}}"`, `'${JSON.stringify(options[key])}'`);
			});

			html = html.replace('{{WEBVIEW_ENDPOINT}}', JSON.stringify(options.WEBVIEW_ENDPOINT));

			return [html, {
				"Content-Type": "text/html",
			}];
		}

		try {
			const content = await util.promisify(fs.readFile)(
				path.join(this.rootPath, requestPath),
			);
			return [content, {
				"Content-Type": getMediaMime(requestPath) || {
					".css": "text/css",
					".html": "text/html",
					".js": "text/js",
					".json": "application/json",
				}[extname(requestPath)] || "text/plain",
			}];
		} catch (error) {
			if (error.code === "ENOENT" || error.code === "EISDIR") {
				throw new HttpError("Not found", HttpCode.NotFound);
			}
			throw error;
		}
	}

	private handleUpgrade(request: http.IncomingMessage, socket: net.Socket): Socket {
		if (request.headers.upgrade !== "websocket") {
			throw new Error("HTTP/1.1 400 Bad Request");
		}

		const options = {
			reconnectionToken: "",
			reconnection: false,
			skipWebSocketFrames: false,
		};

		if (request.url) {
			const query = url.parse(request.url, true).query;
			if (query.reconnectionToken) {
				options.reconnectionToken = query.reconnectionToken as string;
			}
			if (query.reconnection === "true") {
				options.reconnection = true;
			}
			if (query.skipWebSocketFrames === "true") {
				options.skipWebSocketFrames = true;
			}
		}

		const nodeSocket = new Socket(socket, options);
		nodeSocket.upgrade(request.headers["sec-websocket-key"] as string);

		return nodeSocket;
	}

	public listen(port: number = 8443): void {
		this.server.listen(port, () => {
			const address = this.server.address();
			const location = typeof address === "string"
				? address
				: `port ${address.port}`;
			console.log(`Listening on ${location}`);
			console.log(`Serving ${this.rootPath}`);
		});
	}
}
