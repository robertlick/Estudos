import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const db = new Database('database.sqlite');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Inicialização do Banco de Dados
db.exec(`
  CREATE TABLE IF NOT EXISTS subjects (id TEXT PRIMARY KEY, name TEXT, color TEXT);
  CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, subject_id TEXT, title TEXT, content TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, note_id TEXT, filename TEXT, file_type TEXT, data TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS flashcards (id TEXT PRIMARY KEY, note_id TEXT, front TEXT, back TEXT, difficulty TEXT, next_review DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, title TEXT, type TEXT DEFAULT 'tutor', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, image_data TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`);

// Migrações (Adicionar colunas se não existirem)
try {
  const columns = db.prepare("PRAGMA table_info(chat_messages)").all() as any[];
  const hasSessionId = columns.some(c => c.name === 'session_id');
  const hasImageData = columns.some(c => c.name === 'image_data');
  const sessionColumns = db.prepare("PRAGMA table_info(chat_sessions)").all() as any[];
  const hasType = sessionColumns.some(c => c.name === 'type');
  
  if (!hasSessionId) {
    db.prepare("ALTER TABLE chat_messages ADD COLUMN session_id TEXT").run();
    console.log("Migration: Added session_id to chat_messages");
  }
  if (!hasImageData) {
    db.prepare("ALTER TABLE chat_messages ADD COLUMN image_data TEXT").run();
    console.log("Migration: Added image_data to chat_messages");
  }
  if (!hasType) {
    db.prepare("ALTER TABLE chat_sessions ADD COLUMN type TEXT DEFAULT 'tutor'").run();
    console.log("Migration: Added type to chat_sessions");
  }
} catch (e) {
  console.error("Migration error:", e);
}

// API
app.get('/api/config', (req, res) => {
  res.json({ 
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    APP_URL: process.env.APP_URL
  });
});

app.post('/api/ai/generate', async (req, res) => {
  try {
    const { contents, config, model } = req.body;
    const response = await ai.models.generateContent({
      model: model || 'gemini-3-flash-preview',
      contents,
      config
    });
    res.json({ text: response.text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ai/flashcards', async (req, res) => {
  try {
    const { content } = req.body;
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Gere 3 flashcards (Pergunta/Resposta) sobre: ${content}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: { 
            type: Type.OBJECT, 
            properties: { 
              front: { type: Type.STRING }, 
              back: { type: Type.STRING } 
            }, 
            required: ['front', 'back'] 
          }
        }
      }
    });
    res.json(JSON.parse(response.text || '[]'));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ai/digitize', async (req, res) => {
  try {
    const { image } = req.body;
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: { 
        parts: [
          { inlineData: { data: image.split(',')[1], mimeType: 'image/jpeg' } }, 
          { text: 'Transcreva este texto manuscrito de forma organizada e bonita usando Markdown. Retorne APENAS um objeto JSON com os campos "title" (um título curto e descritivo extraído do texto) e "content" (o conteúdo formatado em Markdown). NÃO inclua introduções ou comentários fora do JSON.' } 
        ] 
      },
      config: { responseMimeType: 'application/json' }
    });
    res.json(JSON.parse(response.text || '{}'));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/subjects', (req, res) => res.json(db.prepare('SELECT * FROM subjects').all()));
app.post('/api/subjects', (req, res) => {
  const { name, color } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO subjects (id, name, color) VALUES (?, ?, ?)').run(id, name, color);
  res.json({ id, name, color });
});

app.get('/api/notes', (req, res) => res.json(db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all()));
app.post('/api/notes', (req, res) => {
  const { subject_id, title, content } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO notes (id, subject_id, title, content) VALUES (?, ?, ?, ?)').run(id, subject_id, title, content);
  res.json({ id, subject_id, title, content });
});

app.put('/api/notes/:id', (req, res) => {
  const { title, content, subject_id } = req.body;
  db.prepare('UPDATE notes SET title = ?, content = ?, subject_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, content, subject_id, req.params.id);
  res.json({ success: true });
});

app.get('/api/files', (req, res) => res.json(db.prepare('SELECT id, note_id, filename, file_type, data, created_at FROM files ORDER BY created_at DESC').all()));
app.get('/api/files/:id', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (file) res.json(file);
  else res.status(404).json({ error: 'File not found' });
});
app.post('/api/files', (req, res) => {
  const { note_id, filename, file_type, data } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO files (id, note_id, filename, file_type, data) VALUES (?, ?, ?, ?, ?)').run(id, note_id, filename, file_type, data);
  res.json({ id });
});

app.get('/api/flashcards', (req, res) => res.json(db.prepare('SELECT * FROM flashcards').all()));
app.post('/api/flashcards', (req, res) => {
  const { note_id, front, back } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO flashcards (id, note_id, front, back) VALUES (?, ?, ?, ?)').run(id, note_id, front, back);
  res.json({ id });
});

app.put('/api/flashcards/:id', (req, res) => {
  const { difficulty, next_review } = req.body;
  db.prepare('UPDATE flashcards SET difficulty = ?, next_review = ? WHERE id = ?').run(difficulty, next_review, req.params.id);
  res.json({ success: true });
});

app.get('/api/chat/sessions', (req, res) => {
  const { type } = req.query;
  if (type) {
    res.json(db.prepare('SELECT * FROM chat_sessions WHERE type = ? ORDER BY created_at DESC').all(type));
  } else {
    res.json(db.prepare('SELECT * FROM chat_sessions ORDER BY created_at DESC').all());
  }
});
app.post('/api/chat/sessions', (req, res) => {
  const { title, type } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO chat_sessions (id, title, type) VALUES (?, ?, ?)').run(id, title || 'Nova Conversa', type || 'tutor');
  res.json({ id, title, type: type || 'tutor' });
});
app.put('/api/chat/sessions/:id', (req, res) => {
  const { title } = req.body;
  db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, req.params.id);
  res.json({ success: true });
});
app.delete('/api/chat/sessions/:id', (req, res) => {
  db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(req.params.id);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/chat/messages/:sessionId', (req, res) => {
  res.json(db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC').all(req.params.sessionId));
});
app.post('/api/chat/messages', (req, res) => {
  const { session_id, role, content, image_data } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO chat_messages (id, session_id, role, content, image_data) VALUES (?, ?, ?, ?, ?)').run(id, session_id, role, content, image_data);
  res.json({ id, session_id, role, content, image_data });
});

app.delete('/api/chat/messages/:id', (req, res) => {
  db.prepare('DELETE FROM chat_messages WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/chat/save-to-chats', (req, res) => {
  const { content, title } = req.body;
  
  // Find or create CHATS subject
  let chatsSubject = db.prepare('SELECT id FROM subjects WHERE name = ?').get('CHATS') as { id: string } | undefined;
  
  if (!chatsSubject) {
    const id = uuidv4();
    db.prepare('INSERT INTO subjects (id, name, color) VALUES (?, ?, ?)').run(id, 'CHATS', '#4f46e5');
    chatsSubject = { id };
  }
  
  const noteId = uuidv4();
  db.prepare('INSERT INTO notes (id, subject_id, title, content) VALUES (?, ?, ?, ?)').run(noteId, chatsSubject.id, title || 'Resposta do Tutor', content);
  
  res.json({ success: true, noteId });
});

app.delete('/api/notes/:id', (req, res) => {
  const { id } = req.params;
  try {
    const deleteTx = db.transaction(() => {
      db.prepare('DELETE FROM flashcards WHERE note_id = ?').run(id);
      db.prepare('DELETE FROM files WHERE note_id = ?').run(id);
      db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    });
    deleteTx();
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

app.delete('/api/subjects/:id', (req, res) => {
  const { id } = req.params;
  try {
    const deleteTx = db.transaction(() => {
      const notes = db.prepare('SELECT id FROM notes WHERE subject_id = ?').all(id) as { id: string }[];
      for (const note of notes) {
        db.prepare('DELETE FROM flashcards WHERE note_id = ?').run(note.id);
        db.prepare('DELETE FROM files WHERE note_id = ?').run(note.id);
      }
      db.prepare('DELETE FROM notes WHERE subject_id = ?').run(id);
      db.prepare('DELETE FROM subjects WHERE id = ?').run(id);
    });
    deleteTx();
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting subject:', error);
    res.status(500).json({ error: 'Failed to delete subject' });
  }
});

app.delete('/api/files/:id', (req, res) => {
  db.prepare('DELETE FROM files WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

async function startServer() {
  // Serve static files from the current directory (for index.html)
  app.use(express.static('.'));
  
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.resolve('index.html'));
  });

  app.listen(PORT, '0.0.0.0', () => console.log(`Server: http://localhost:${PORT}`));
}

startServer();
