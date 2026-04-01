#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const workspaceRoot = path.resolve(process.env.REPO_ROOT || process.cwd());

const server = new McpServer({
	name: "n8n_codex_smoke",
	version: "1.0.0",
});

server.registerTool(
	"ping",
	{
		description: "Returns pong to verify that Codex can invoke MCP tools.",
		inputSchema: {
			text: z.string().optional(),
		},
	},
	async ({ text }) => ({
		content: [
			{
				type: "text",
				text: text ? `pong: ${text}` : "pong",
			},
		],
	}),
);

server.registerTool(
	"workspace_info",
	{
		description: "Returns the workspace root and a sample of top-level entries.",
		inputSchema: {},
	},
	async () => {
		const entries = await fs.readdir(workspaceRoot);
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							workspaceRoot,
							topLevelEntries: entries.sort().slice(0, 20),
						},
						null,
						2,
					),
				},
			],
		};
	},
);

server.registerTool(
	"read_text_file",
	{
		description: "Reads a UTF-8 text file relative to the workspace root.",
		inputSchema: {
			relativePath: z.string().min(1),
		},
	},
	async ({ relativePath }) => {
		const resolvedPath = path.resolve(workspaceRoot, relativePath);
		const relativeResolvedPath = path.relative(workspaceRoot, resolvedPath);

		if (
			relativeResolvedPath.startsWith("..") ||
			path.isAbsolute(relativeResolvedPath)
		) {
			return {
				content: [
					{
						type: "text",
						text: "Path escapes the workspace root.",
					},
				],
				isError: true,
			};
		}

		const content = await fs.readFile(resolvedPath, "utf8");
		return {
			content: [
				{
					type: "text",
					text: content,
				},
			],
		};
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
