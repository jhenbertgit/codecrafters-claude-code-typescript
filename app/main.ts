import OpenAI from "openai";

async function main() {
  const [, , flag, prompt] = process.argv;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  if (flag !== "-p" || !prompt) {
    throw new Error("error: -p flag is required");
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
  });

  while (true) {

    const response = await client.chat.completions.create({
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          type: "function",
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
              required: ["file_path"],
            },
          },
        },
      ],
    });
    

  if (!response.choices || response.choices.length === 0) {
    throw new Error("no choices in response");
  }

  const messages = [...response.choices[0].message];

  const toolCalls = response.choices[0].message.tool_calls;

  if (toolCalls && toolCalls.length > 0) {
    if (toolCalls[0].function.name === "Read") {
      const functionArgs = JSON.parse(toolCalls[0].function.arguments);
      const filePath = functionArgs.file_path;
      const fileContent = await Bun.file(filePath).text();
      messages.push({ role: "user", content: fileContent });
    } else {
      console.error("No tool calls for this command", toolCalls);
    }
  } else {
    // No tool calls, just print the response
    console.log(response.choices[0].message.content);
  }

  // You can use print statements as follows for debugging, they'll be visible when running tests.
  console.error("Logs from your program will appear here!");
}

main();
