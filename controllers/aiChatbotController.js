const { OpenAI } = require('openai');
const db = require('../db');

// Validate OpenAI API key on startup
if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is not set. AI chatbot features will not work.');
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ============================================
// INPUT VALIDATION CONSTANTS
// ============================================
const VALIDATION_LIMITS = {
  MAX_CHAT_MESSAGE_LENGTH: 1000,
  MAX_ITEM_TITLE_LENGTH: 200,
  MAX_ITEM_CATEGORY_LENGTH: 100,
  MAX_ITEM_DESCRIPTION_LENGTH: 500,
  MAX_TOKEN_ESTIMATE: 500,
  MIN_MESSAGE_LENGTH: 1
};

/**
 * Get personalized outfit recommendations based on user's wardrobe
 * GET /api/ai/recommendations
 */
exports.getRecommendations = async (req, res) => {
  try {
    const userId = req.session.user?.user_id;
    if (!userId) {
      return res.status(401).json({ 
        success: false,
        error: 'Not authenticated',
        message: 'Please log in to get recommendations'
      });
    }

    // Fetch user's wardrobe items
    const itemsQuery = `
      SELECT ci.item_id, ci.title, ci.category, ci.color, ci.size_label, ci.condition_grade, b.name as brand
      FROM clothing_items ci
      LEFT JOIN brands b ON ci.brand_id = b.brand_id
      WHERE ci.owner_user_id = ? AND ci.is_for_swap = 1 AND ci.status = 'available'
      LIMIT 15
    `;

    db.query(itemsQuery, [userId], async (err, items) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ 
          success: false,
          error: 'Database error',
          message: 'Failed to retrieve wardrobe. Please try again.'
        });
      }

      if (!items || items.length === 0) {
        return res.json({
          success: false,
          message: 'You need at least 1 item in your wardrobe to get recommendations. Add items in the Wardrobe section first!'
        });
      }

      // Create item summary for AI
      const itemSummary = items
        .map(item => `${item.title} (${item.category}, ${item.color}, ${item.condition_grade})`)
        .join('; ');

      try {
        const message = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content: `You are a professional fashion stylist helping users create amazing outfits. 
                        Analyze their wardrobe and suggest creative outfit combinations. 
                        Be enthusiastic, specific, and practical. Suggest 3-4 outfit ideas.`
            },
            {
              role: 'user',
              content: `My wardrobe includes: ${itemSummary}. 
                        Please suggest some creative outfit combinations I can make from these items for casual everyday wear.`
            }
          ],
          max_tokens: 600,
          temperature: 0.7
        });

        const recommendation = message.choices[0].message.content;

        // Save recommendation to database
        const saveQuery = `
          INSERT INTO style_recommendations (user_id, source_type, message)
          VALUES (?, 'wardrobe', ?)
        `;

        db.query(saveQuery, [userId, recommendation], (saveErr) => {
          if (saveErr) {
            console.error('Error saving recommendation:', saveErr);
            // Don't fail - still return recommendation to user
          }
        });

        res.json({
          success: true,
          recommendation: recommendation,
          itemCount: items.length
        });
      } catch (aiError) {
        console.error('OpenAI API error:', aiError);
        
        // More specific error messages
        let errorMessage = 'Could not generate recommendations. Please try again.';
        if (aiError.code === 'TIMEOUT' || aiError.message.includes('timeout')) {
          errorMessage = 'The AI service took too long to respond. Please check your internet connection and try again.';
        } else if (aiError.status === 429) {
          errorMessage = 'The AI service is busy. Please wait a moment and try again.';
        } else if (aiError.status === 401) {
          errorMessage = 'API key error. Please contact support.';
        }
        
        res.status(500).json({ 
          success: false,
          error: 'AI service error',
          message: errorMessage
        });
      }
    });
  } catch (error) {
    console.error('Controller error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error',
      message: 'Something went wrong. Please try again later.'
    });
  }
};

/**
 * Chat endpoint - general fashion advice
 * POST /api/ai/chat
 */
exports.chat = async (req, res) => {
  try {
    const { message } = req.body;
    const userId = req.session.user?.user_id;

    if (!userId) {
      return res.status(401).json({ 
        success: false,
        error: 'Not authenticated',
        message: 'Please log in to use the chat'
      });
    }

    // ============================================
    // INPUT VALIDATION (Issue #4 Fix)
    // ============================================
    
    // Check if message exists and is not empty
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid input',
        message: 'Please type a message first'
      });
    }

    const trimmedMessage = message.trim();
    const MAX_MESSAGE_LENGTH = VALIDATION_LIMITS.MAX_CHAT_MESSAGE_LENGTH;
    const MIN_MESSAGE_LENGTH = VALIDATION_LIMITS.MIN_MESSAGE_LENGTH;

    // Validate message length
    if (trimmedMessage.length < MIN_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        error: 'Invalid input',
        message: 'Message must not be empty'
      });
    }

    if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        error: 'Input too long',
        message: `Message must be ${MAX_MESSAGE_LENGTH} characters or less. Your message has ${trimmedMessage.length} characters.`
      });
    }

    // Check for suspicious patterns (basic prompt injection prevention)
    const suspiciousPatterns = [
      /ignore previous|disregard previous|forget the system|override system/gi,
      /system prompt|system instruction|jailbreak/gi,
      /execute code|run script|eval\(/gi
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(trimmedMessage)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid input',
          message: 'Your message contains suspicious content. Please rephrase and try again.'
        });
      }
    }

    // Estimate token count (rough: ~4 chars = 1 token, GPT-4 model)
    const estimatedTokens = Math.ceil(trimmedMessage.length / 4);
    if (estimatedTokens > 500) {
      return res.status(400).json({
        success: false,
        error: 'Input too long',
        message: 'Your message is too long for the chat. Please shorten it.'
      });
    }

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: `You are a helpful fashion and clothing swap assistant for a platform called "Wardrobe Plug". 
                      Help users with:
                      - Outfit styling advice and fashion tips
                      - Clothing care and maintenance tips
                      - Swap negotiation suggestions
                      - Wardrobe organization ideas
                      - Fashion trends and style guides
                      Be concise, friendly, and practical. Keep responses under 150 words unless asked for more detail.`
          },
          {
            role: 'user',
            content: trimmedMessage
          }
        ],
        max_tokens: 300,
        temperature: 0.7
      });

      const reply = response.choices[0].message.content;

      res.json({
        success: true,
        reply: reply
      });
    } catch (aiError) {
      console.error('OpenAI API error:', aiError);
      console.error('Error details:', {
        message: aiError.message,
        status: aiError.status,
        code: aiError.code,
        error: aiError.error
      });
      
      // Better error messages for chat
      let errorMessage = 'Could not process your message. Please try again.';
      if (aiError.code === 'TIMEOUT' || aiError.message.includes('timeout')) {
        errorMessage = 'The AI service is responding slowly. Check your internet and try again.';
      } else if (aiError.status === 429) {
        errorMessage = 'The AI service is busy. Please wait a moment and try again.';
      } else if (aiError.status === 401) {
        errorMessage = 'Authentication error. Please refresh and try again.';
      } else if (aiError.message.includes('network')) {
        errorMessage = 'Network error. Check your internet connection and try again.';
      } else if (aiError.error?.message) {
        errorMessage = aiError.error.message;
      }
      
      res.status(500).json({ 
        success: false,
        error: 'Chat error',
        message: errorMessage
      });
    }
  } catch (error) {
    console.error('Controller error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error',
      message: 'Something went wrong. Please try again later.'
    });
  }
};

/**
 * Get AI suggestions for tags based on item description
 * POST /api/ai/suggest-tags
 */
exports.suggestTags = async (req, res) => {
  try {
    const { itemTitle, itemDescription, itemCategory } = req.body;
    const userId = req.session.user?.user_id;

    if (!userId) {
      return res.status(401).json({ 
        success: false,
        error: 'Not authenticated',
        message: 'Please log in to get tag suggestions'
      });
    }

    // ============================================
    // INPUT VALIDATION (Issue #4 Fix)
    // ============================================

    // Validate itemTitle
    if (!itemTitle || typeof itemTitle !== 'string' || itemTitle.trim().length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing input',
        message: 'Please enter an item title first'
      });
    }

    const trimmedTitle = itemTitle.trim();
    if (trimmedTitle.length > VALIDATION_LIMITS.MAX_ITEM_TITLE_LENGTH) {
      return res.status(400).json({
        success: false,
        error: 'Input too long',
        message: `Item title must be ${VALIDATION_LIMITS.MAX_ITEM_TITLE_LENGTH} characters or less`
      });
    }

    // Validate itemCategory length to prevent token waste
    if (itemCategory) {
      const trimmedCategory = String(itemCategory).trim();
      if (trimmedCategory.length > VALIDATION_LIMITS.MAX_ITEM_CATEGORY_LENGTH) {
        return res.status(400).json({
          success: false,
          error: 'Input too long',
          message: `Item category must be ${VALIDATION_LIMITS.MAX_ITEM_CATEGORY_LENGTH} characters or less`
        });
      }
    }

    // Validate itemDescription length
    if (itemDescription) {
      const trimmedDescription = String(itemDescription).trim();
      if (trimmedDescription.length > VALIDATION_LIMITS.MAX_ITEM_DESCRIPTION_LENGTH) {
        return res.status(400).json({
          success: false,
          error: 'Input too long',
          message: `Item description must be ${VALIDATION_LIMITS.MAX_ITEM_DESCRIPTION_LENGTH} characters or less`
        });
      }
    }

    try {
      const prompt = `Suggest 5-7 relevant fashion tags for this clothing item:
                      Title: ${trimmedTitle}
                      Category: ${itemCategory || 'general'}
                      Description: ${itemDescription || 'No description'}
                      
                      Return ONLY tag names separated by commas, nothing else.
                      Keep tags short (1-2 words max) and relevant to fashion/clothing.`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a fashion tagging expert. Suggest relevant tags for clothing items.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 100,
        temperature: 0.5
      });

      const tagString = response.choices[0].message.content;
      const suggestedTags = tagString
        .split(',')
        .map(tag => tag.trim().toLowerCase())
        .filter(tag => tag.length > 0)
        .slice(0, 10); // Limit to 10 tags max

      res.json({
        success: true,
        suggestedTags: suggestedTags
      });
    } catch (aiError) {
      console.error('OpenAI API error:', aiError);
      
      // Better error messages for tag suggestions
      let errorMessage = 'Could not generate tag suggestions. Please try again.';
      if (aiError.code === 'TIMEOUT' || aiError.message.includes('timeout')) {
        errorMessage = 'Tag generation is taking too long. Check your internet and try again.';
      } else if (aiError.status === 429) {
        errorMessage = 'AI service is busy. Please wait and try again.';
      } else if (aiError.status === 401) {
        errorMessage = 'API authentication failed. Please contact support.';
      }
      
      res.status(500).json({ 
        success: false,
        error: 'Tag suggestion error',
        message: errorMessage
      });
    }
  } catch (error) {
    console.error('Controller error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error',
      message: 'Something went wrong. Please try again later.'
    });
  }
};

/**
 * Get style analysis based on OOTD posts
 * GET /api/ai/style-analysis
 */
exports.getStyleAnalysis = async (req, res) => {
  try {
    const userId = req.session.user?.user_id;
    if (!userId) {
      return res.status(401).json({ 
        success: false,
        error: 'Not authenticated',
        message: 'Please log in to get style analysis'
      });
    }

    // Fetch user's OOTD posts
    const postsQuery = `
      SELECT post_id, caption, created_at
      FROM ootd_posts
      WHERE user_id = ? AND visibility = 'public'
      ORDER BY created_at DESC
      LIMIT 10
    `;

    db.query(postsQuery, [userId], async (err, posts) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ 
          success: false,
          error: 'Database error',
          message: 'Failed to retrieve your posts. Please try again.'
        });
      }

      if (!posts || posts.length === 0) {
        return res.json({
          success: false,
          message: 'You have no OOTD posts yet. Create some public posts first in the OOTD section!'
        });
      }

      const postSummary = posts
        .map(post => post.caption || 'No caption')
        .join('; ');

      try {
        const message = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content: `You are a fashion analyst. Analyze the user's posted outfits and provide insights about their personal style.
                        Identify patterns, strengths, and suggestions for improvement.`
            },
            {
              role: 'user',
              content: `Here are my recent OOTD posts: ${postSummary}. 
                        Please analyze my style and give me personalized fashion advice.`
            }
          ],
          max_tokens: 500,
          temperature: 0.7
        });

        const analysis = message.choices[0].message.content;

        // Save analysis to recommendations
        const saveQuery = `
          INSERT INTO style_recommendations (user_id, source_type, message)
          VALUES (?, 'ootd', ?)
        `;

        db.query(saveQuery, [userId, analysis], (saveErr) => {
          if (saveErr) {
            console.error('Error saving analysis:', saveErr);
            // Don't fail - still return analysis to user
          }
        });

        res.json({
          success: true,
          analysis: analysis,
          postCount: posts.length
        });
      } catch (aiError) {
        console.error('OpenAI API error:', aiError);
        
        let errorMessage = 'Could not analyze your style. Please try again.';
        if (aiError.code === 'TIMEOUT' || aiError.message.includes('timeout')) {
          errorMessage = 'Style analysis is taking too long. Check your internet and try again.';
        } else if (aiError.status === 429) {
          errorMessage = 'AI service is busy. Please wait a moment and try again.';
        } else if (aiError.status === 401) {
          errorMessage = 'API error. Please contact support.';
        }
        
        res.status(500).json({ 
          success: false,
          error: 'Analysis error',
          message: errorMessage
        });
      }
    });
  } catch (error) {
    console.error('Controller error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error',
      message: 'Something went wrong. Please try again later.'
    });
  }
};

/**
 * Get user's recommendation history
 * GET /api/ai/recommendations-history
 */
exports.getRecommendationHistory = (req, res) => {
  try {
    const userId = req.session.user?.user_id;
    if (!userId) {
      return res.status(401).json({ 
        success: false,
        error: 'Not authenticated',
        message: 'Please log in to view recommendations'
      });
    }

    const query = `
      SELECT recommendation_id, source_type, message, created_at
      FROM style_recommendations
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `;

    db.query(query, [userId], (err, recommendations) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ 
          success: false,
          error: 'Database error',
          message: 'Failed to retrieve history. Please try again.'
        });
      }

      res.json({
        success: true,
        recommendations: recommendations || [],
        count: (recommendations || []).length
      });
    });
  } catch (error) {
    console.error('Controller error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error',
      message: 'Something went wrong. Please try again later.'
    });
  }
};
