import { exec } from "child_process";
import cors from "cors";
import dotenv from "dotenv";
import voice from "elevenlabs-node";
import express from "express";
import { promises as fs } from "fs";
import { Groq } from "groq-sdk";
import path from "path";

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
const port = process.env.PORT || 3000;

// Knowledge base variables
let knowledgeBase = "";

// Audio generation timeout (10 seconds)
const AUDIO_TIMEOUT = 10000;

// Ensure audio directory exists
async function ensureAudioDir() {
  const audioDir = path.join(process.cwd(), "audios");
  try {
    await fs.mkdir(audioDir, { recursive: true });
    console.log("Audio directory confirmed");
  } catch (error) {
    console.error("Error creating audio directory:", error);
  }
  return audioDir;
}

// Function to load knowledge base
async function loadKnowledgeBase() {
  try {
    knowledgeBase = await fs.readFile(
      path.join(process.cwd(), "idms_knowledge_base.js"), 
      "utf8"
    );
    console.log("Knowledge base loaded successfully");
  } catch (error) {
    console.error("Error loading knowledge base:", error);
    knowledgeBase = ""; // Set empty if file not found
  }
}

// Test ElevenLabs API connection
async function testElevenLabsConnection() {
  try {
    if (!elevenLabsApiKey) {
      console.error("ElevenLabs API key not found");
      return false;
    }
    
    const voices = await Promise.race([
      voice.getVoices(elevenLabsApiKey),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout")), 5000)
      )
    ]);
    
    console.log("ElevenLabs API connection successful");
    return true;
  } catch (error) {
    console.error("ElevenLabs API connection failed:", error.message);
    return false;
  }
}

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/voices", async (req, res) => {
  try {
    const voices = await voice.getVoices(elevenLabsApiKey);
    res.send(voices);
  } catch (error) {
    console.error("Error fetching voices:", error);
    res.status(500).send({ error: "Failed to fetch voices" });
  }
});

app.get("/health", async (req, res) => {
  const health = {
    server: "running",
    groqApi: !!groqApiKey,
    elevenLabsApi: !!elevenLabsApiKey,
    knowledgeBase: !!knowledgeBase,
    timestamp: new Date().toISOString()
  };
  
  try {
    const elevenLabsConnected = await testElevenLabsConnection();
    health.elevenLabsConnected = elevenLabsConnected;
  } catch (error) {
    health.elevenLabsConnected = false;
  }
  
  res.json(health);
});

const execCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Exec error:", error);
        reject(error);
      }
      resolve(stdout);
    });
  });
};

// Default lipsync data to use when files aren't available
const DEFAULT_LIPSYNC = {
  metadata: {
    soundFile: "default.wav",
    duration: 2.0
  },
  mouthCues: [
    { start: 0.0, end: 0.2, value: "X" },
    { start: 0.2, end: 0.4, value: "A" },
    { start: 0.4, end: 0.6, value: "E" },
    { start: 0.6, end: 0.8, value: "O" },
    { start: 0.8, end: 1.0, value: "U" },
    { start: 1.0, end: 1.2, value: "A" },
    { start: 1.2, end: 1.4, value: "E" },
    { start: 1.4, end: 1.6, value: "O" },
    { start: 1.6, end: 1.8, value: "X" },
    { start: 1.8, end: 2.0, value: "X" }
  ]
};

// Enhanced audio generation with better error handling and timeout
async function generateAudioWithTimeout(apiKey, voiceId, fileName, text) {
  console.log(`Attempting to generate audio for: "${text.substring(0, 50)}..."`);
  
  return new Promise(async (resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.error("Audio generation timeout");
      reject(new Error("Audio generation timeout"));
    }, AUDIO_TIMEOUT);

    try {
      await voice.textToSpeech(apiKey, voiceId, fileName, text);
      clearTimeout(timeoutId);
      console.log("Audio generation successful");
      resolve();
    } catch (error) {
      clearTimeout(timeoutId);
      console.error("Audio generation failed:", error.message);
      reject(error);
    }
  });
}

app.post("/chat", async (req, res) => {
  console.log("=== Chat request received ===");
  const audioDir = await ensureAudioDir();
  const userMessage = req.body.message;
  
  if (!userMessage) {
    try {
      const introAudioPath = path.join(audioDir, "intro_0.wav");
      let audioData = "";
      let lipsyncData = DEFAULT_LIPSYNC;
      
      try {
        audioData = await audioFileToBase64(introAudioPath);
        lipsyncData = await readJsonTranscript(path.join(audioDir, "intro_0.json"));
      } catch (error) {
        console.log("Using default audio/lipsync for intro");
      }
      
      res.send({
        messages: [
          {
            text: "Hey there! How can I help you with IDMS information today?",
            audio: audioData,
            lipsync: lipsyncData,
            facialExpression: "smile",
            animation: "Talking_1",
          },
        ],
      });
      return;
    } catch (error) {
      console.error("Error handling empty message:", error);
    }
  }
  
  if (!elevenLabsApiKey || !groqApiKey) {
    console.warn("API keys not properly configured");
    console.log("ElevenLabs API Key present:", !!elevenLabsApiKey);
    console.log("Groq API Key present:", !!groqApiKey);
    
    res.send({
      messages: [
        {
          text: "Please ensure your API keys are properly set up!",
          audio: "",
          lipsync: DEFAULT_LIPSYNC,
          facialExpression: "angry",
          animation: "Angry",
        },
      ],
    });
    return;
  }

  try {
    console.log("Processing user message:", userMessage);
    
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

    console.log("Checking domain relevance...");
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
    
    console.log("Domain relevance result:", isDomainRelevant);

    // If query isn't related to our domain, return a message indicating the limitation
    if (!isDomainRelevant && knowledgeBase) {
      const messageText = "I'm Kom Ai specialized in IDMS ERP systems and GST integration. I don't have information on topics outside this domain. Can I help you with any IDMS or GST related questions?";
      
      let audioData = "";
      try {
        const fileName = path.join(audioDir, "message_domain.mp3");
        console.log("Generating audio for domain restriction message...");
        
        await generateAudioWithTimeout(
          elevenLabsApiKey,
          voiceID,
          fileName,
          messageText
        );
        
        audioData = await audioFileToBase64(fileName);
        console.log("Domain message audio generated successfully");
      } catch (error) {
        console.error("Error generating audio for domain message:", error);
        audioData = ""; // Ensure it's empty string, not undefined
      }

      const messages = [
        {
          text: messageText,
          facialExpression: "smile",
          animation: "Talking_0",
          audio: audioData,
          lipsync: DEFAULT_LIPSYNC
        },
      ];

      console.log("Sending domain restriction response");
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

    console.log("Generating response with Groq...");
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
    console.log("Raw response from Groq:", responseContent);
    let messages;

    try {
      // Check if the response is already valid JSON
      messages = JSON.parse(responseContent);

      // Handle both formats (direct array or object with messages property)
      if (messages.messages) {
        messages = messages.messages;
      }
    } catch (e) {
      console.error("Error parsing JSON response:", e);
      // If not valid JSON, try to extract JSON from the text
      const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          messages = JSON.parse(jsonMatch[0]);
          if (messages.messages) {
            messages = messages.messages;
          }
        } catch (innerError) {
          console.error("Error parsing extracted JSON:", innerError);
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

    console.log(`Processing ${messages.length} messages for audio generation`);

    // Process each message to generate audio and lipsync
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      console.log(`Processing message ${i}: "${message.text.substring(0, 50)}..."`);
      
      try {
        // Generate audio file
        const fileName = path.join(audioDir, `message_${i}_${Date.now()}.mp3`);
        const textInput = message.text;
        
        console.log(`Generating audio for message ${i}...`);
        await generateAudioWithTimeout(
          elevenLabsApiKey,
          voiceID,
          fileName,
          textInput
        );
        
        console.log(`Reading audio file for message ${i}...`);
        message.audio = await audioFileToBase64(fileName);
        
        // Clean up the file after converting to base64
        try {
          await fs.unlink(fileName);
          console.log(`Cleaned up audio file: ${fileName}`);
        } catch (cleanupError) {
          console.warn(`Could not clean up file ${fileName}:`, cleanupError.message);
        }
        
        message.lipsync = DEFAULT_LIPSYNC;
        console.log(`Message ${i} processed successfully with audio`);
        
      } catch (error) {
        console.error(`Error processing message ${i}:`, error);
        message.audio = ""; // Ensure it's empty string
        message.lipsync = DEFAULT_LIPSYNC;
        console.log(`Message ${i} processed with fallback (no audio)`);
      }
    }

    console.log("=== Sending final response ===");
    console.log("Messages with audio status:", messages.map((msg, i) => ({
      messageIndex: i,
      hasAudio: !!msg.audio,
      audioLength: msg.audio ? msg.audio.length : 0,
      text: msg.text.substring(0, 30) + "..."
    })));
    
    res.send({ messages });
  } catch (error) {
    console.error("Error with Groq API:", error);
    res.status(500).send({
      messages: [
        {
          text: "Sorry, there was an error processing your message with the Groq API.",
          facialExpression: "sad",
          animation: "Idle",
          audio: "",
          lipsync: DEFAULT_LIPSYNC
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
    return DEFAULT_LIPSYNC;
  }
};

const audioFileToBase64 = async (file) => {
  try {
    console.log(`Reading audio file: ${file}`);
    const data = await fs.readFile(file);
    const base64 = data.toString("base64");
    console.log(`Audio file converted to base64, length: ${base64.length}`);
    return base64;
  } catch (error) {
    console.error(`Error reading audio file ${file}:`, error);
    return "";
  }
};

// Load knowledge base and start server
async function startServer() {
  try {
    console.log("=== Starting IDMS Knowledge Assistant ===");
    
    await loadKnowledgeBase();
    await ensureAudioDir();
    
    // Test ElevenLabs connection
    const elevenLabsOk = await testElevenLabsConnection();
    console.log("ElevenLabs API Status:", elevenLabsOk ? "Connected" : "Failed");
    
    app.listen(port, () => {
      console.log(`🚀 IDMS Knowledge Assistant listening on port ${port}`);
      console.log(`📊 Health check available at: http://localhost:${port}/health`);
      console.log("=== Server Ready ===");
    });
  } catch (error) {
    console.error("Failed to start server:", error);
  }
}

startServer();
