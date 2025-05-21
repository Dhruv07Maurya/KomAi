import { exec } from "child_process";
import cors from "cors";
import dotenv from "dotenv";
import voice from "elevenlabs-node";
import express from "express";
import { promises as fs } from "fs";
import { Groq } from "groq-sdk";

// Load environment variables
dotenv.config();
const groqApiKey = process.env.GROQ_API_KEY;
// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ElevenLabs config
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const voiceID = process.env.VOICE_ID;

const app = express();
app.use(express.json());
app.use(cors());
const port = 3000;

// Knowledge base variables
let knowledgeBase = "";

// Function to load knowledge base
async function loadKnowledgeBase() {
  try {
    knowledgeBase = await fs.readFile("idms_knowledge_base.js", "utf8");
    console.log("Knowledge base loaded successfully");
  } catch (error) {
    console.error("Error loading knowledge base:", error);
    knowledgeBase = ""; // Set empty if file not found
  }
}

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/voices", async (req, res) => {
  res.send(await voice.getVoices(elevenLabsApiKey));
});

const execCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(error);
      resolve(stdout);
    });
  });
};

// const lipSyncMessage = async (message) => {
//   const time = new Date().getTime();
//   console.log(`Starting conversion for message ${message}`);
//   await execCommand(
//     `ffmpeg -y -i audios/message_${message}.mp3 audios/message_${message}.wav`
//     // -y to overwrite the file
//   );
//   console.log(`Conversion done in ${new Date().getTime() - time}ms`);
//   await execCommand(
//     `./bin/rhubarb -f json -o audios/message_${message}.json audios/message_${message}.wav -r phonetic`
//   );
//   // -r phonetic is faster but less accurate
//   console.log(`Lip sync done in ${new Date().getTime() - time}ms`);
// };

app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;
  if (!userMessage) {
    res.send({
      messages: [
        {
          text: "Hey there! How can I help you with IDMS information today?",
          audio: await audioFileToBase64("audios/intro_0.wav"),
          lipsync: await readJsonTranscript("audios/intro_0.json"),
          facialExpression: "smile",
          animation: "Talking_1",
        },
      ],
    });
    return;
  }
  if (!elevenLabsApiKey || !groqApiKey) {
    res.send({
      messages: [
        {
          text: "Please ensure your API keys are properly set up!",
          audio: await audioFileToBase64("audios/api_0.wav"),
          lipsync: await readJsonTranscript("audios/api_1.json"),
          facialExpression: "angry",
          animation: "Angry",
        },
      ],
    });
    return;
  }

  try {
    // First, use Groq to determine if the query is related to the knowledge base domain
    const domainCheckPrompt = `
    You are a filter that determines if a query is related to the following domain:
    your name is kom ai {you are Kom AI, a virtual assistant for IDMS ERP system}
    avoid outside question that is not from knowlede base
    - IDMS ERP system
    - ERP modules like Sales, Purchase, Inventory, Production, etc.
    - GST Integration
    - Business software systems
    - Enterprise software
    
    Query: "${userMessage}"
    
    Respond with ONLY "RELEVANT" if the query is related to these topics, or "IRRELEVANT" if it's completely unrelated.
    `;

    const domainCheck = await groq.chat.completions.create({
      model: "llama3-8b-8192",
      messages: [
        {
          role: "user",
          content: domainCheckPrompt,
        },
      ],
      max_tokens: 10,
      temperature: 0.1,
    });

    const isDomainRelevant =
      domainCheck.choices[0].message.content.includes("RELEVANT");

    // If query isn't related to our domain, return a message indicating the limitation
    if (!isDomainRelevant && knowledgeBase) {
      const messages = [
        {
          text: "I'm Kom Ai specialized in IDMS ERP systems and GST integration. I don't have information on topics outside this domain. Can I help you with any IDMS or GST related questions?",
          facialExpression: "smile",
          animation: "Talking_0",
        },
      ];

      // Process message for audio
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const fileName = `audios/message_${i}.mp3`;
        await voice.textToSpeech(
          elevenLabsApiKey,
          voiceID,
          fileName,
          message.text
        );
        message.audio = await audioFileToBase64(fileName);
        message.lipsync = await readJsonTranscript("audios/api_1.json");
      }

      res.send({ messages });
      return;
    }

    // Prepare the system prompt with knowledge base content
    const systemPrompt = `
    your name is kom ai {you are Kom AI, a virtual assistant for IDMS ERP system}
    You are a virtual assistant specialized in the IDMS ERP system.
    You will always reply with a JSON array of messages. With a maximum of 3 messages.
    Each message has a text, facialExpression, and animation property.
    The different facial expressions are: smile, sad, angry, surprised, funnyFace, and default.
    The different animations are: Talking_0, Talking_1, Talking_2, Crying, Laughing, Rumba, Idle, Terrified, and Angry.
    Your response must be a valid JSON object with a 'messages' array.
    avoid outside question that is not from knowlede base
    IMPORTANT: You must ONLY answer based on the following knowledge base information. If the information to answer the query is not contained here, state that you don't have that specific information in your knowledge base:
    
    ${knowledgeBase}
    `;

    // Now use Groq to generate a response based only on the knowledge base
    const completion = await groq.chat.completions.create({
      model: "llama3-8b-8192",
      max_tokens: 1000,
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    // Parse the response as JSON
    let responseContent = completion.choices[0].message.content;
    let messages;

    try {
      // Check if the response is already valid JSON
      messages = JSON.parse(responseContent);

      // Handle both formats (direct array or object with messages property)
      if (messages.messages) {
        messages = messages.messages;
      }
    } catch (e) {
      // If not valid JSON, try to extract JSON from the text
      const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          messages = JSON.parse(jsonMatch[0]);
          if (messages.messages) {
            messages = messages.messages;
          }
        } catch (innerError) {
          // Fallback to a basic message if JSON parsing fails
          messages = [
            {
              text: "Sorry, I couldn't generate a proper response. Could you try again?",
              facialExpression: "sad",
              animation: "Idle",
            },
          ];
        }
      } else {
        // Fallback message
        messages = [
          {
            text: "Sorry, I couldn't generate a proper response. Could you try again?",
            facialExpression: "sad",
            animation: "Idle",
          },
        ];
      }
    }

    // Ensure messages is an array
    if (!Array.isArray(messages)) {
      messages = [messages];
    }

    // Process each message to generate audio and lipsync
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      // generate audio file
      const fileName = `audios/message_${i}.mp3`; // The name of your audio file
      const textInput = message.text; // The text you wish to convert to speech
      await voice.textToSpeech(elevenLabsApiKey, voiceID, fileName, textInput);
      // generate lipsync
      // await lipSyncMessage(i);
      message.audio = await audioFileToBase64(fileName);
      message.lipsync = await readJsonTranscript("audios/api_1.json");
    }

    res.send({ messages });
  } catch (error) {
    console.error("Error with Groq API:", error);
    res.status(500).send({
      messages: [
        {
          text: "Sorry, there was an error processing your message with the Groq API.",
          facialExpression: "sad",
          animation: "Idle",
        },
      ],
    });
  }
});

const readJsonTranscript = async (file) => {
  try {
    const data = await fs.readFile(file, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading JSON file ${file}:`, error);
    // Return a minimal empty lipsync object as fallback
    return { mouthCues: [] };
  }
};

const audioFileToBase64 = async (file) => {
  try {
    const data = await fs.readFile(file);
    return data.toString("base64");
  } catch (error) {
    console.error(`Error reading audio file ${file}:`, error);
    return "";
  }
};

// Load knowledge base and start server
loadKnowledgeBase().then(() => {
  app.listen(port, () => {
    console.log(`IDMS Knowledge Assistant listening on port ${port}`);
  });
});
