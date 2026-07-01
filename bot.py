import json
import os
import urllib.request
import urllib.error
import re
from datetime import datetime
from telegram import Update, BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, CopyTextButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

from config import BOT_TOKEN, ADMIN_ID

USERS_FILE = "users.json"
LINK_FILE = "current_link.json"
LOG_FILE = "cloudflared.log"
LOCAL_SERVER = "http://127.0.0.1:7860"

# States: admin_states for commands, user_states for support chat
admin_states = {}
user_states = {}

def load_users():
    if not os.path.exists(USERS_FILE): return {}
    with open(USERS_FILE, "r") as f: return json.load(f)

def save_users(users):
    with open(USERS_FILE, "w") as f: json.dump(users, f, indent=2)

def load_link():
    if os.path.exists(LOG_FILE):
        try:
            with open(LOG_FILE, "r", encoding="utf-8") as f:
                content = f.read()
                matches = re.findall(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", content)
                if matches:
                    latest_url = matches[-1]
                    save_link(latest_url)
                    return latest_url
        except Exception: pass
    if os.path.exists(LINK_FILE):
        with open(LINK_FILE, "r") as f: return json.load(f).get("url")
    return None

def save_link(url):
    with open(LINK_FILE, "w") as f:
        json.dump({"url": url, "updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}, f, indent=2)

def is_server_online():
    try: urllib.request.urlopen(LOCAL_SERVER, timeout=3); return True
    except: return False

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    users = load_users()
    if str(user.id) not in users:
        users[str(user.id)] = {"username": user.username, "first_name": user.first_name, "joined": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
        save_users(users)
    await update.message.reply_text("🎵 *Welcome to AURA Music Bot!*", parse_mode="Markdown")

async def latest(update: Update, context: ContextTypes.DEFAULT_TYPE):
    url = load_link()
    if url:
        keyboard = [[InlineKeyboardButton("📋 Copy Link", copy_text=CopyTextButton(text=url))]]
        await update.message.reply_text(f"🔗 *Aura Music App Latest Link:*\n\n`{url}`", parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(keyboard))
    else:
        await update.message.reply_text("Server abhi update ho raha hai.")

async def status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    s = "Online ✅" if is_server_online() else "Offline ❌"
    await update.message.reply_text(f"📊 *Server Status:*\nApp is {s}", parse_mode="Markdown")

# SUPPORT SYSTEM
async def message_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_states[update.effective_user.id] = "SENDING_SUPPORT"
    await update.message.reply_text("Apna message bhejiye:")

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    if uid in admin_states: admin_states.pop(uid)
    if uid in user_states: user_states.pop(uid)
    await update.message.reply_text("❌ Action cancelled.")

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    
    # 1. Admin Reply Logic (Reply to message)
    if uid == ADMIN_ID and update.message.reply_to_message:
        quoted = update.message.reply_to_message.text
        match = re.search(r"🆔 ID: (\d+)", quoted)
        if match:
            target_id = match.group(1)
            try:
                await context.bot.send_message(target_id, update.message.text, parse_mode="Markdown")
                await update.message.reply_text("✅ Reply sent.")
                return
            except Exception as e: await update.message.reply_text(f"❌ Error: {e}")

    # 2. User Support Message Logic
    if user_states.get(uid) == "SENDING_SUPPORT":
        user = update.effective_user
        # Format as requested
        msg = f"📩 *New Message*\n\n👤 Name: {user.first_name}\n🆔 ID: `{user.id}`\n🌐 Username: @{user.username}\n\n{update.message.text}"
        await context.bot.send_message(ADMIN_ID, msg, parse_mode="Markdown")
        user_states.pop(uid)
        await update.message.reply_text("✅ Message sent to Admin.")
        return

    # 3. Existing Admin State Logic (setlink/broadcast)
    state = admin_states.get(uid)
    if state == "WAITING_LINK":
        save_link(update.message.text.strip())
        admin_states.pop(uid)
        await update.message.reply_text("✅ Link saved.")
    elif state == "WAITING_BROADCAST":
        users = load_users()
        for u in users:
            try: await context.bot.send_message(chat_id=u, text=update.message.text)
            except: pass
        admin_states.pop(uid)
        await update.message.reply_text("✅ Broadcast complete.")

# ADMIN COMMANDS
async def setlink(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id != ADMIN_ID: return
    admin_states[update.effective_user.id] = "WAITING_LINK"
    await update.message.reply_text("🔗 Send the new URL:")

async def broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id != ADMIN_ID: return
    admin_states[update.effective_user.id] = "WAITING_BROADCAST"
    await update.message.reply_text("📢 Send the broadcast message:")

async def auto_broadcast(application):
    users = load_users()
    url = load_link()
    if url:
        msg = f"📢 *Bot Online!*\n🔗 *Latest Link:*\n`{url}`"
        keyboard = [[InlineKeyboardButton("📋 Copy Link", copy_text=CopyTextButton(text=url))]]
        for user_id in users:
            try: await application.bot.send_message(chat_id=user_id, text=msg, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(keyboard))
            except: pass

async def post_init(application):
    await application.bot.set_my_commands([
        BotCommand("start", "Start"),
        BotCommand("latest", "Get Link"),
        BotCommand("status", "Server Status"),
        BotCommand("message", "Message Admin"),
        BotCommand("setlink", "Set Link (Admin)"),
        BotCommand("broadcast", "Broadcast (Admin)"),
        BotCommand("cancel", "Cancel Action")
    ])
    await auto_broadcast(application)

def main():
    app = Application.builder().token(BOT_TOKEN).post_init(post_init).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("latest", latest))
    app.add_handler(CommandHandler("status", status))
    app.add_handler(CommandHandler("message", message_start))
    app.add_handler(CommandHandler("setlink", setlink))
    app.add_handler(CommandHandler("broadcast", broadcast))
    app.add_handler(CommandHandler("cancel", cancel))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    print("Bot started...")
    app.run_polling()

if __name__ == "__main__":
    main()
