import OpenAI from "openai";

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "Read",
      description: "Read the contents of a file",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The path to the file",
          },
        },
        required: ["file_path"] as const,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "Write",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The path to the file",
          },
          content: {
            type: "string",
            description: "The content to write",
          },
        },
        required: ["file_path", "content"] as const,
      },
    },
  },
];

const MODEL = "anthropic/claude-haiku-4.5";

type Message = {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: OpenAI.ChatCompletionMessageToolCall[];
};

function validateEnv(): { apiKey: string; baseURL: string } {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const baseURL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  return { apiKey, baseURL };
}

function parseArgs(): { flag: string; prompt: string } {
  const [, , flag, prompt] = process.argv;
  if (flag !== "-p" || !prompt) {
    throw new Error("error: -p flag is required");
  }
  return { flag, prompt };
}

async function handleToolCall(call: OpenAI.ChatCompletionMessageToolCall): Promise<Message> {
  if (call.function.name === "Read") {
    const args = JSON.parse(call.function.arguments) as { file_path: string };
    const content = await Bun.file(args.file_path).text();
    return { role: "tool", tool_call_id: call.id, content };
  }
  if (call.function.name === "Write") {
    const args = JSON.parse(call.function.arguments) as { file_path: string; content: string };
    await Bun.write(args.file_path, args.content);
    return { role: "tool", tool_call_id: call.id, content: `Wrote to ${args.file_path}` };
  }
  throw new Error(`Unknown tool: ${call.function.name}`);
}

async function chatLoop(client: OpenAI, initialPrompt: string): Promise<void> {
  const messages: Message[] = [{ role: "user", content: initialPrompt }];

  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: messages as unknown as OpenAI.ChatCompletionMessageParam[],
      tools: TOOLS,
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("no choices in response");

    messages.push({
      role: "assistant",
      content: choice.message.content || "",
      tool_calls: choice.message.tool_calls,
    });

    if (choice.message.tool_calls?.length) {
      for (const call of choice.message.tool_calls) {
        messages.push(await handleToolCall(call));
      }
    } else {
      console.log(choice.message.content);
      break;
    }
  }
}

async function main(): Promise<void> {
  const { apiKey, baseURL } = validateEnv();
  const { prompt } = parseArgs();

  const client = new OpenAI({ apiKey, baseURL });
  await chatLoop(client, prompt);
}

main();
