import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService } from "./services/figma.js";
import { simplifyRawFigmaObject, allExtractors } from "./extractors/index.js";

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Authless Calculator",
		version: "1.0.0",
	});

	private getFigmaService(auth?: { figmaApiKey?: string; figmaOAuthToken?: string; useOAuth?: boolean }) {
		return new FigmaService({
			figmaApiKey: auth?.figmaApiKey || "",
			figmaOAuthToken: auth?.figmaOAuthToken || "",
			useOAuth: !!auth?.useOAuth && !!auth?.figmaOAuthToken,
		});
	}

	async init() {
		// Simple addition tool
		this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
		}));

		// Calculator tool with multiple operations
		this.server.tool(
			"calculate",
			{
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			},
			async ({ operation, a, b }) => {
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "subtract":
						result = a - b;
						break;
					case "multiply":
						result = a * b;
						break;
					case "divide":
						if (b === 0)
							return {
								content: [
									{
										type: "text",
										text: "Error: Cannot divide by zero",
									},
								],
							};
						result = a / b;
						break;
				}
				return { content: [{ type: "text", text: String(result) }] };
			},
		);

		// Figma tools (wrapping src/services/figma.ts)

		// 1) Get raw Figma file
		this.server.tool(
			"get_raw_figma_file",
			{
				figmaApiKey: z.string().optional(),
				figmaOAuthToken: z.string().optional(),
				useOAuth: z.boolean().optional(),
				fileKey: z.string(),
				depth: z.number().optional(),
			},
			async ({ figmaApiKey, figmaOAuthToken, useOAuth, fileKey, depth }) => {
				const figma = this.getFigmaService({ figmaApiKey, figmaOAuthToken, useOAuth });
				const res = await figma.getRawFile(fileKey, depth);
				return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
			},
		);

		// 2) Get raw Figma node
		this.server.tool(
			"get_raw_figma_node",
			{
				figmaApiKey: z.string().optional(),
				figmaOAuthToken: z.string().optional(),
				useOAuth: z.boolean().optional(),
				fileKey: z.string(),
				nodeId: z.string(),
				depth: z.number().optional(),
			},
			async ({ figmaApiKey, figmaOAuthToken, useOAuth, fileKey, nodeId, depth }) => {
				const figma = this.getFigmaService({ figmaApiKey, figmaOAuthToken, useOAuth });
				const res = await figma.getRawNode(fileKey, nodeId, depth);
				return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
			},
		);

		// 3) Get image fill URLs
		this.server.tool(
			"get_figma_image_fill_urls",
			{
				figmaApiKey: z.string().optional(),
				figmaOAuthToken: z.string().optional(),
				useOAuth: z.boolean().optional(),
				fileKey: z.string(),
			},
			async ({ figmaApiKey, figmaOAuthToken, useOAuth, fileKey }) => {
				const figma = this.getFigmaService({ figmaApiKey, figmaOAuthToken, useOAuth });
				const res = await figma.getImageFillUrls(fileKey);
				return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
			},
		);

		// 4) Get rendered node URLs (PNG/SVG)
		this.server.tool(
			"get_figma_node_render_urls",
			{
				figmaApiKey: z.string().optional(),
				figmaOAuthToken: z.string().optional(),
				useOAuth: z.boolean().optional(),
				fileKey: z.string(),
				nodeIds: z.array(z.string()).min(1),
				format: z.enum(["png", "svg"]),
				options: z
					.object({
						pngScale: z.number().positive().optional(),
						svgOptions: z
							.object({
								outlineText: z.boolean().optional(),
								includeId: z.boolean().optional(),
								simplifyStroke: z.boolean().optional(),
							})
							.optional(),
					})
					.optional(),
			},
			async ({ figmaApiKey, figmaOAuthToken, useOAuth, fileKey, nodeIds, format, options }) => {
				const figma = this.getFigmaService({ figmaApiKey, figmaOAuthToken, useOAuth });
				const res = await figma.getNodeRenderUrls(fileKey, nodeIds, format, options ?? {});
				return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
			},
		);

		// 5) Download images with processing (PNG/SVG, cropping, dimensions)
		this.server.tool(
			"download_figma_images",
			{
				figmaApiKey: z.string().optional(),
				figmaOAuthToken: z.string().optional(),
				useOAuth: z.boolean().optional(),
				fileKey: z.string(),
				nodes: z
					.object({
						nodeId: z.string().regex(/^\d+:\d+$/, "Node ID must be in the format of 'number:number'"),
						imageRef: z.string().optional(),
						fileName: z
							.string()
							.regex(
								/^[a-zA-Z0-9_.-]+$/,
								"File name can only contain alphanumeric characters, underscores, dots, and hyphens",
							),
						needsCropping: z.boolean().optional(),
						cropTransform: z.array(z.array(z.number())).optional(),
						requiresImageDimensions: z.boolean().optional(),
						filenameSuffix: z.string().optional(),
					})
					.array()
					.min(1),
				pngScale: z.number().positive().optional().default(2),
				localPath: z.string(),
			},
			async ({ figmaApiKey, figmaOAuthToken, useOAuth, fileKey, nodes, localPath, pngScale = 2 }) => {
				const figma = this.getFigmaService({ figmaApiKey, figmaOAuthToken, useOAuth });

				const downloadItems: Array<any> = [];
				const downloadToRequests = new Map<number, string[]>();
				const seenDownloads = new Map<string, number>();

				for (const node of nodes) {
					let finalFileName = node.fileName;
					if (node.filenameSuffix && !finalFileName.includes(node.filenameSuffix)) {
						const ext = finalFileName.split(".").pop();
						const nameWithoutExt = finalFileName.substring(0, finalFileName.lastIndexOf("."));
						finalFileName = `${nameWithoutExt}-${node.filenameSuffix}.${ext}`;
					}

					const downloadItem = {
						fileName: finalFileName,
						needsCropping: node.needsCropping || false,
						cropTransform: node.cropTransform,
						requiresImageDimensions: node.requiresImageDimensions || false,
					};

					if (node.imageRef) {
						const uniqueKey = `${node.imageRef}-${node.filenameSuffix || "none"}`;
						if (!node.filenameSuffix && seenDownloads.has(uniqueKey)) {
							const downloadIndex = seenDownloads.get(uniqueKey)!;
							const requests = downloadToRequests.get(downloadIndex)!;
							if (!requests.includes(finalFileName)) requests.push(finalFileName);
							if (downloadItem.requiresImageDimensions) {
								downloadItems[downloadIndex].requiresImageDimensions = true;
							}
						} else {
							const downloadIndex = downloadItems.length;
							downloadItems.push({ ...downloadItem, imageRef: node.imageRef });
							downloadToRequests.set(downloadIndex, [finalFileName]);
							seenDownloads.set(uniqueKey, downloadIndex);
						}
					} else {
						const downloadIndex = downloadItems.length;
						downloadItems.push({ ...downloadItem, nodeId: node.nodeId });
						downloadToRequests.set(downloadIndex, [finalFileName]);
					}
				}

				const results = await figma.downloadImages(fileKey, localPath, downloadItems, { pngScale });
				const successCount = results.filter(Boolean).length;

				const imagesList = results
					.map((result, index) => {
						const fileName = result.filePath.split("/").pop() || result.filePath;
						const dimensions = `${result.finalDimensions.width}x${result.finalDimensions.height}`;
						const cropStatus = result.wasCropped ? " (cropped)" : "";
						const dimensionInfo = result.cssVariables ? `${dimensions} | ${result.cssVariables}` : dimensions;

						const requestedNames = downloadToRequests.get(index) || [fileName];
						const aliasText =
							requestedNames.length > 1
								? ` (also requested as: ${requestedNames.filter((n) => n !== fileName).join(", ")})`
								: "";

						return `- ${fileName}: ${dimensionInfo}${cropStatus}${aliasText}`;
					})
					.join("\n");

				return {
					content: [{ type: "text", text: `Downloaded ${successCount} images:\n${imagesList}` }],
				};
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
