// Claude API Backend for Sequential Questionnaire Chatbot
// Install dependencies: npm install @anthropic-ai/sdk express cors dotenv

const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // Set your API key in .env file
});

// Store conversation sessions (in production, use a database)
const sessions = new Map();

// ==========================================
// APPROACH 1: Simple System Prompt
// ==========================================
const SYSTEM_PROMPT_SIMPLE = `You are a friendly financial information collection assistant. 

Your task is to collect the following information from users IN THIS EXACT ORDER:
1. Name (ask: "What is your name?")
2. Age (ask: "What is your age?")
3. Annual income (ask: "What is your annual income?")
4. Cash on hand (ask: "How much cash do you have?")
5. Retirement savings (ask: "How much do you have in your retirement account?")

IMPORTANT RULES:
- Start by asking for their name with a friendly greeting
- Ask ONE question at a time and wait for their response
- Keep track of what you've already collected
- After getting an answer, acknowledge it briefly and ask the next question
- Once you have all 5 pieces of information, let them know you're done collecting data
- Then offer to answer questions about their finances (net worth, totals, etc.)
- Be conversational and natural

When answering questions after data collection:
- Calculate net worth as: cash + retirement savings
- Provide clear, formatted numbers with dollar signs
- Be helpful and informative`;

// ==========================================
// APPROACH 2: Structured State Management
// ==========================================
class ConversationState {
  constructor() {
    this.currentStep = 0;
    this.collectedData = {};
    this.steps = [
      { id: 'name', question: 'What is your name?', field: 'name' },
      { id: 'age', question: 'What is your age?', field: 'age' },
      { id: 'income', question: 'What is your annual income?', field: 'income' },
      { id: 'cash', question: 'How much cash do you have?', field: 'cash' },
      { id: 'retirement', question: 'How much do you have in your retirement account?', field: 'retirement' }
    ];
    this.conversationHistory = [];
  }

  getCurrentQuestion() {
    if (this.currentStep < this.steps.length) {
      return this.steps[this.currentStep].question;
    }
    return null;
  }

  isDataCollectionComplete() {
    return this.currentStep >= this.steps.length;
  }

  storeResponse(value) {
    if (this.currentStep < this.steps.length) {
      const step = this.steps[this.currentStep];
      this.collectedData[step.field] = value;
      this.currentStep++;
    }
  }

  buildSystemPrompt() {
    if (this.isDataCollectionComplete()) {
      return `You are a helpful financial assistant. The user has provided the following data:
${JSON.stringify(this.collectedData, null, 2)}

You can:
1. Answer questions about their finances (net worth, totals, comparisons)
2. If they want to UPDATE existing data, respond with: UPDATE_DATA|field|newValue
   Example: "UPDATE_DATA|cash|5000"
3. If they want to ADD new data fields, respond with: ADD_DATA|fieldName|value
   Example: "ADD_DATA|stocks|25000"

When users say things like:
- "Actually my cash is $5000" → UPDATE_DATA|cash|5000
- "I also have $25k in stocks" → ADD_DATA|stocks|25000
- "Change my age to 36" → UPDATE_DATA|age|36

Otherwise, answer their questions naturally using the data provided.`;
    } else {
      const currentField = this.steps[this.currentStep].field;
      return `You are collecting financial information. You just asked for the user's ${currentField}.
Extract their ${currentField} from their response, acknowledge it briefly, and I'll tell you what to ask next.`;
    }
  }
  
  updateData(field, value) {
    this.collectedData[field] = value;
  }
  
  addNewData(field, value) {
    this.collectedData[field] = value;
  }
}

// ==========================================
// APPROACH 3: Tool/Function Calling
// ==========================================
const TOOLS = [
  {
    name: "store_user_data",
    description: "Store a piece of user data that was collected. Call this after the user provides information.",
    input_schema: {
      type: "object",
      properties: {
        field: {
          type: "string",
          enum: ["name", "age", "income", "cash", "retirement"],
          description: "The field name for the data being stored"
        },
        value: {
          type: "string",
          description: "The value provided by the user"
        }
      },
      required: ["field", "value"]
    }
  },
  {
    name: "get_collected_data",
    description: "Retrieve all collected user data to answer questions",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  }
];

const SYSTEM_PROMPT_WITH_TOOLS = `You are a financial data collection assistant with access to tools.

Your process:
1. Greet the user and ask for their name
2. After they respond, use store_user_data to save it
3. Continue asking for: age, income, cash, retirement (one at a time)
4. Use store_user_data after each response
5. After all data is collected, offer to answer questions
6. Use get_collected_data to retrieve information when answering questions

Ask ONE question at a time and be conversational.`;

// ==========================================
// API ENDPOINTS
// ==========================================

// Note: The simple system-prompt endpoint was removed. Use '/chat/structured' or '/chat/tools' instead.

// Endpoint 2: Structured state approach
app.post('/chat/structured', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, new ConversationState());
    }
    
    const state = sessions.get(sessionId);
    
    // If first message, greet and ask first question
    if (state.conversationHistory.length === 0) {
      const greeting = `Hello! I'm here to collect some financial information. ${state.getCurrentQuestion()}`;
      state.conversationHistory.push({ role: 'assistant', content: greeting });
      return res.json({ response: greeting, sessionId: sessionId });
    }

    state.conversationHistory.push({ role: 'user', content: message });

    // If still collecting data
    if (!state.isDataCollectionComplete()) {
      // Store the response
      state.storeResponse(message);
      
      // Get next question or finish
      if (state.isDataCollectionComplete()) {
        const completion = "Great! I've collected all your information. You can now ask me questions like 'What is my net worth?' or 'Show me my information'.";
        state.conversationHistory.push({ role: 'assistant', content: completion });
        return res.json({ response: completion, sessionId: sessionId });
      } else {
        const nextQuestion = `Got it! ${state.getCurrentQuestion()}`;
        state.conversationHistory.push({ role: 'assistant', content: nextQuestion });
        return res.json({ response: nextQuestion, sessionId: sessionId });
      }
    }

    // Data collection complete - use Claude to answer questions
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: state.buildSystemPrompt(),
      messages: state.conversationHistory
    });

    let assistantMessage = response.content[0].text;
    
    // Check if Claude wants to update or add data
    if (assistantMessage.startsWith('UPDATE_DATA|')) {
      const [_, field, value] = assistantMessage.split('|');
      state.updateData(field, value);
      assistantMessage = `Got it! I've updated your ${field} to ${value}. Your updated information is now saved.`;
      state.conversationHistory.push({ role: 'assistant', content: assistantMessage });
    } else if (assistantMessage.startsWith('ADD_DATA|')) {
      const [_, field, value] = assistantMessage.split('|');
      state.addNewData(field, value);
      assistantMessage = `Perfect! I've added ${field}: ${value} to your profile.`;
      state.conversationHistory.push({ role: 'assistant', content: assistantMessage });
    } else {
      state.conversationHistory.push({ role: 'assistant', content: assistantMessage });
    }

    res.json({ 
      response: assistantMessage,
      sessionId: sessionId,
      collectedData: state.collectedData
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint 3: Tool calling approach
app.post('/chat/tools', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        conversationHistory: [],
        collectedData: {}
      });
    }
    
    const session = sessions.get(sessionId);
    session.conversationHistory.push({ role: 'user', content: message });

    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT_WITH_TOOLS,
      tools: TOOLS,
      messages: session.conversationHistory
    });

    // Handle tool calls
    while (response.stop_reason === 'tool_use') {
      const toolUse = response.content.find(block => block.type === 'tool_use');
      
      let toolResult;
      if (toolUse.name === 'store_user_data') {
        // Store the data
        session.collectedData[toolUse.input.field] = toolUse.input.value;
        toolResult = { success: true, message: `Stored ${toolUse.input.field}` };
      } else if (toolUse.name === 'get_collected_data') {
        toolResult = session.collectedData;
      }

      // Continue conversation with tool result
      session.conversationHistory.push({ role: 'assistant', content: response.content });
      session.conversationHistory.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(toolResult)
        }]
      });

      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT_WITH_TOOLS,
        tools: TOOLS,
        messages: session.conversationHistory
      });
    }

    const textContent = response.content.find(block => block.type === 'text');
    const assistantMessage = textContent ? textContent.text : 'I apologize, I encountered an issue.';
    
    session.conversationHistory.push({ role: 'assistant', content: assistantMessage });

    res.json({ 
      response: assistantMessage,
      sessionId: sessionId,
      collectedData: session.collectedData
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`
Available endpoints:
- POST /chat/structured - Structured state management
- POST /chat/tools - Tool/function calling approach
  `);
});

module.exports = app;