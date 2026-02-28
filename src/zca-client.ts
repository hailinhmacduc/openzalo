/**
 * ZCA Client — Singleton wrapper around zca-js library.
 *
 * Replaces openzca CLI subprocess spawning with direct in-process API calls
 * for stable, persistent WebSocket connections to Zalo servers.
 */
import { Zalo, ThreadType } from "zca-js";
import type { Credentials, API as ZcaAPI } from "zca-js";
import type { AddReactionDestination } from "zca-js";
import type { Message } from "zca-js";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ZcaClientOptions = {
    profile: string;
    credentialsDir?: string;
    onMessage?: (message: ZcaInboundMessage) => void | Promise<void>;
    onReaction?: (reaction: unknown) => void | Promise<void>;
    onGroupEvent?: (event: unknown) => void | Promise<void>;
    onDisconnect?: (code: number, reason: string) => void;
    onReconnect?: () => void;
    logger?: ZcaLogger;
};

export type ZcaLogger = {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
};

export type ZcaInboundMessage = {
    messageId: string;
    msgId?: string;
    cliMsgId?: string;
    threadId: string;
    senderId: string;
    senderName?: string;
    text: string;
    timestamp: number;
    isGroup: boolean;
    isSelf: boolean;
    /** Local file paths to downloaded media */
    mediaPaths: string[];
    mediaTypes: string[];
    /** Raw zca-js message for quote/reply */
    rawMessage: Message;
};

export type ZcaSendResult = {
    messageId: string;
    msgId?: string;
};

// ─── Image Metadata Getter (required by zca-js v2) ────────────────────────────

async function imageMetadataGetter(filePath: string) {
    const data = await fs.readFile(filePath);
    const metadata = await sharp(data).metadata();
    return {
        height: metadata.height!,
        width: metadata.width!,
        size: metadata.size || data.length,
    };
}

// ─── Credential Management ──────────────────────────────────────────────────

function getCredentialsPath(profile: string, credentialsDir?: string): string {
    const dir =
        credentialsDir || path.join(os.homedir(), ".openzca", "profiles", profile);
    return path.join(dir, "credentials.json");
}

async function loadCredentials(
    profile: string,
    credentialsDir?: string
): Promise<Credentials | null> {
    const credPath = getCredentialsPath(profile, credentialsDir);
    try {
        const raw = await fs.readFile(credPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && parsed.imei && parsed.cookie && parsed.userAgent) {
            return parsed as Credentials;
        }
        return null;
    } catch {
        return null;
    }
}

async function saveCredentials(
    profile: string,
    credentials: Credentials,
    credentialsDir?: string
): Promise<void> {
    const credPath = getCredentialsPath(profile, credentialsDir);
    await fs.mkdir(path.dirname(credPath), { recursive: true });
    await fs.writeFile(credPath, JSON.stringify(credentials, null, 2), "utf-8");
}

// ─── Media Download Helper ──────────────────────────────────────────────────

const MEDIA_CACHE_DIR = path.join(os.tmpdir(), "openzalo-media");

async function downloadMediaToLocal(
    url: string,
    ext: string = "bin"
): Promise<string | null> {
    try {
        await fs.mkdir(MEDIA_CACHE_DIR, { recursive: true });
        const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const filePath = path.join(MEDIA_CACHE_DIR, filename);

        const response = await fetch(url);
        if (!response.ok) {
            return null;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(filePath, buffer);
        return filePath;
    } catch {
        return null;
    }
}

function guessExtFromUrl(url: string): string {
    const match = url.match(/\.(\w{2,5})(?:\?|$)/);
    return match?.[1] || "bin";
}

// ─── Singleton Client Manager ───────────────────────────────────────────────

const clients = new Map<string, ZcaClient>();

export class ZcaClient {
    private zalo: Zalo;
    private api: ZcaAPI | null = null;
    private profile: string;
    private credentialsDir?: string;
    private options: ZcaClientOptions;
    private listenerStarted = false;
    private _selfId: string = "";
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelayMs = 2000;

    private constructor(options: ZcaClientOptions) {
        this.profile = options.profile;
        this.credentialsDir = options.credentialsDir;
        this.options = options;
        this.zalo = new Zalo({ imageMetadataGetter });
    }

    /**
     * Get or create a ZcaClient for the given profile.
     */
    static getInstance(options: ZcaClientOptions): ZcaClient {
        const key = options.profile;
        let client = clients.get(key);
        if (!client) {
            client = new ZcaClient(options);
            clients.set(key, client);
        }
        // Update callbacks on existing instance
        client.options = { ...client.options, ...options };
        return client;
    }

    /**
     * Remove and stop a client instance.
     */
    static removeInstance(profile: string): void {
        const client = clients.get(profile);
        if (client) {
            client.stop();
            clients.delete(profile);
        }
    }

    get isConnected(): boolean {
        return this.api !== null;
    }

    get selfId(): string {
        return this._selfId;
    }

    private log(
        level: "info" | "warn" | "error",
        msg: string,
        meta?: Record<string, unknown>
    ) {
        this.options.logger?.[level](msg, meta);
    }

    /**
     * Login using saved credentials or QR code.
     */
    async login(): Promise<void> {
        const creds = await loadCredentials(this.profile, this.credentialsDir);

        if (creds) {
            this.log("info", `Restoring session from credentials (profile: ${this.profile})`);
            try {
                this.api = await this.zalo.login(creds);
                this._selfId = String(this.api.getOwnId());
                this.reconnectAttempts = 0;
                this.log("info", `Session restored (selfId: ${this._selfId})`);
                return;
            } catch (err) {
                this.log("warn", `Credential login failed, falling back to QR`, {
                    error: String(err),
                });
            }
        }

        // Fallback: QR login
        this.log("info", `Starting QR login (profile: ${this.profile})`);
        this.api = await this.zalo.loginQR();
        this._selfId = String(this.api.getOwnId());

        // Save credentials for next time
        try {
            const context = this.api.getContext();
            if (context) {
                await saveCredentials(
                    this.profile,
                    context as unknown as Credentials,
                    this.credentialsDir
                );
                this.log("info", `Credentials saved for profile: ${this.profile}`);
            }
        } catch (err) {
            this.log("warn", `Failed to save credentials`, { error: String(err) });
        }

        this.reconnectAttempts = 0;
        this.log("info", `QR login successful (selfId: ${this._selfId})`);
    }

    /**
     * Start the message listener.
     */
    async startListener(): Promise<void> {
        if (!this.api) {
            throw new Error("ZcaClient: not logged in. Call login() first.");
        }
        if (this.listenerStarted) {
            this.log("warn", "Listener already running, skipping restart");
            return;
        }

        const api = this.api;

        api.listener.on("message", async (message: Message) => {
            try {
                const isSelf = Boolean((message as any).isSelf);
                if (isSelf) return; // Skip own messages

                const isGroup = message.type === ThreadType.Group;
                const content = message.data?.content;
                const text = typeof content === "string" ? content : "";

                // Download media if present
                const mediaPaths: string[] = [];
                const mediaTypes: string[] = [];

                if (content && typeof content === "object") {
                    // Image or file message — try to download
                    const thumb =
                        (content as any).thumb ||
                        (content as any).href ||
                        (content as any).normalUrl;
                    if (thumb && typeof thumb === "string") {
                        const ext = guessExtFromUrl(thumb);
                        const localPath = await downloadMediaToLocal(thumb, ext);
                        if (localPath) {
                            mediaPaths.push(localPath);
                            mediaTypes.push(ext === "bin" ? "file" : `image/${ext}`);
                        }
                    }
                }

                const inbound: ZcaInboundMessage = {
                    messageId: String(message.data?.msgId || Date.now()),
                    msgId: message.data?.msgId ? String(message.data.msgId) : undefined,
                    cliMsgId: message.data?.cliMsgId
                        ? String(message.data.cliMsgId)
                        : undefined,
                    threadId: String(message.threadId),
                    senderId: String(message.data?.uidFrom || ""),
                    senderName: (message.data as any)?.dName || undefined,
                    text,
                    timestamp: message.data?.ts ? Number(message.data.ts) : Date.now(),
                    isGroup,
                    isSelf,
                    mediaPaths,
                    mediaTypes,
                    rawMessage: message,
                };

                await this.options.onMessage?.(inbound);
            } catch (err) {
                this.log("error", "Error processing inbound message", {
                    error: String(err),
                });
            }
        });

        api.listener.on("reaction", (reaction) => {
            this.options.onReaction?.(reaction);
        });

        api.listener.on("group_event", (event) => {
            this.options.onGroupEvent?.(event);
        });

        api.listener.on("disconnected", (code, reason) => {
            this.log("warn", `Listener disconnected (code: ${code}, reason: ${reason})`);
            this.listenerStarted = false;
            this.options.onDisconnect?.(code, reason);
            this.handleReconnect();
        });

        api.listener.on("error", (err) => {
            this.log("error", "Listener error", { error: String(err) });
        });

        api.listener.start({ retryOnClose: true });
        this.listenerStarted = true;
        this.log("info", "Listener started");
    }

    /**
     * Handle disconnection with auto-reconnect.
     */
    private async handleReconnect(): Promise<void> {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.log("error", "Max reconnect attempts reached, giving up");
            return;
        }

        this.reconnectAttempts++;
        const delay =
            this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);
        this.log("info", `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        await new Promise((r) => setTimeout(r, delay));

        try {
            await this.login();
            await this.startListener();
            this.options.onReconnect?.();
            this.log("info", "Reconnected successfully");
        } catch (err) {
            this.log("error", "Reconnect failed", { error: String(err) });
            await this.handleReconnect();
        }
    }

    /**
     * Send a text message.
     */
    async sendText(
        threadId: string,
        text: string,
        isGroup: boolean,
        quoteMessage?: Message
    ): Promise<ZcaSendResult> {
        if (!this.api) throw new Error("ZcaClient: not logged in");

        const type = isGroup ? ThreadType.Group : ThreadType.User;
        const msgContent: any = { msg: text };
        if (quoteMessage) {
            msgContent.quote = quoteMessage.data;
        }

        const result = await this.api.sendMessage(msgContent, threadId, type);
        return {
            messageId: result?.message?.msgId
                ? String(result.message.msgId)
                : "ok",
            msgId: result?.message?.msgId
                ? String(result.message.msgId)
                : undefined,
        };
    }

    /**
     * Send a message with file/image attachments.
     */
    async sendMedia(
        threadId: string,
        filePaths: string[],
        text?: string,
        isGroup: boolean = false
    ): Promise<ZcaSendResult> {
        if (!this.api) throw new Error("ZcaClient: not logged in");

        const type = isGroup ? ThreadType.Group : ThreadType.User;
        const msgContent: any = {
            msg: text || "",
            attachments: filePaths,
        };

        const result = await this.api.sendMessage(msgContent, threadId, type);
        return {
            messageId: result?.message?.msgId
                ? String(result.message.msgId)
                : "ok",
            msgId: result?.message?.msgId
                ? String(result.message.msgId)
                : undefined,
        };
    }

    /**
     * Send typing indicator.
     */
    async sendTyping(threadId: string, isGroup: boolean): Promise<void> {
        if (!this.api) throw new Error("ZcaClient: not logged in");
        try {
            const type = isGroup ? ThreadType.Group : ThreadType.User;
            await this.api.sendTypingEvent(threadId, type);
        } catch {
            // Typing indicator failure is non-critical
        }
    }

    /**
     * Add a reaction to a message.
     */
    async addReaction(
        msgId: string,
        cliMsgId: string,
        threadId: string,
        reaction: string,
        isGroup: boolean
    ): Promise<void> {
        if (!this.api) throw new Error("ZcaClient: not logged in");
        const type = isGroup ? ThreadType.Group : ThreadType.User;
        const dest: AddReactionDestination = {
            data: { msgId, cliMsgId },
            threadId,
            type,
        };
        await this.api.addReaction(reaction as any, dest);
    }

    /**
     * Stop the client and listener.
     */
    stop(): void {
        if (this.api && this.listenerStarted) {
            try {
                this.api.listener.stop();
            } catch {
                // Ignore
            }
        }
        this.listenerStarted = false;
        this.api = null;
        this.log("info", "Client stopped");
    }
}

export { ThreadType };
