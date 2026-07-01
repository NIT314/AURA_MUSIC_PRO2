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

admin_states = {}

def load_users():
    if not os.path.exists(USERS_FILE):
        return {}
    with open(USERS_FILE, "r") as f:
        return json.load(f)

def save_users(users):
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)

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
        except Exception:
            pass

    if not os.path.exists(LINK_FILE):
        return None
    with open(LINK_FILE, "r") as f:
        return json.load(f).get("url")

def save_link(url):
    with open(LINK_FILE, "w") as f:
        json.dump(
            {"url": url, "updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S")},
            f,
            indent=2,
        )

def is_server_online():
    try:
        urllib.request.urlopen(LOCAL_SERVER, timeout=3)
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    users = load_users()

    if str(user.id) not in users:
        users[str(user.id)] = {
            "username": user.username,
            "first_name": user.first_name,
            "joined": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        save_users(users)

    await update.message.reply_text(
        "🎵 *Welcome to AURA Music Bot!*\n\n"
        "Main aapko Aura Music App ki latest URL provide karunga.\n\n"
        "👉 URL lene ke liye /latest dabayein.",
        parse_mode="Markdown"
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Available commands:\n"
        "/start - Register with the bot\n"
        "/help - Show this message\n"
        "/latest - Get latest server link\n"
        "/status - Check server status"
    )

async def latest(update: Update, context: ContextTypes.DEFAULT_TYPE):
    url = load_link()
    if url:
        # Yahan specifically Telegram ka naya CopyTextButton use kiya hai
        keyboard = [[InlineKeyboardButton("📋 Copy Link", copy_text=CopyTextButton(text=url))]]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await update.message.reply_text(
            f"🔗 *Aura Music App Latest Link:*\n\n`{url}`", 
            parse_mode="Markdown",
            reply_markup=reply_markup
        )
    else:
        await update.message.reply_text("Server abhi update ho raha hai. Please thodi der me try karein.")

async def status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if is_server_online():
        await update.message.reply_text("📊 *Server Status:*\nApp is Online ✅", parse_mode="Markdown")
    else:
        await update.message.reply_text("📊 *Server Status:*\nApp is Offline ❌", parse_mode="Markdown")

async def setlink(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if user.id != ADMIN_ID:
        await update.message.reply_text("You are not authorized.")
        return

    if context.args:
        url = context.args[0]
        save_link(url)
        await update.message.reply_text(f"Link updated:\n{url}")
    else:
        admin_states[user.id] = "WAITING_LINK"
        await update.message.reply_text("🔗 Kripya naya URL bhejiye:\n\n(Cancel karne ke liye /cancel dabayein)")

async def broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if user.id != ADMIN_ID:
        await update.message.reply_text("You are not authorized.")
        return

    if context.args:
        message = " ".join(context.args)
        users = load_users()
        await update.message.reply_text(f"Broadcasting to {len(users)} users...")
        success, failed = 0, 0
        for user_id in users:
            try:
                await context.bot.send_message(chat_id=user_id, text=message)
                success += 1
            except Exception:
                failed += 1
        await update.message.reply_text(f"Broadcast complete!\n✅ Success: {success}\n❌ Failed: {failed}")
    else:
        admin_states[user.id] = "WAITING_BROADCAST"
        await update.message.reply_text("📢 Kripya apna message likhein:\n\n(Cancel karne ke liye /cancel dabayein)")

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if user.id in admin_states:
        admin_states.pop(user.id)
        await update.message.reply_text("❌ Action cancel kar diya gaya hai.")
    else:
        await update.message.reply_text("Koi action pending nahi tha.")

async def handle_admin_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if user.id != ADMIN_ID:
        return 
        
    state = admin_states.get(user.id)
    text = update.message.text
    
    if state == "WAITING_LINK":
        save_link(text.strip())
        admin_states.pop(user.id, None)
        await update.message.reply_text(f"✅ Naya Link Save Ho Gaya:\n{text}")
        
    elif state == "WAITING_BROADCAST":
        users = load_users()
        await update.message.reply_text(f"Broadcasting to {len(users)} users...")
        success, failed = 0, 0
        for user_id in users:
            try:
                await context.bot.send_message(chat_id=user_id, text=text)
                success += 1
            except Exception:
                failed += 1
        admin_states.pop(user.id, None)
        await update.message.reply_text(f"✅ Broadcast complete!\nSuccess: {success}\nFailed: {failed}")
    else:
        await update.message.reply_text("Kripya menu se koi command chunein.")

async def post_init(application):
    await application.bot.set_my_commands([
        BotCommand("start", "Register with the bot"),
        BotCommand("help", "Show available commands"),
        BotCommand("latest", "Get latest server link"),
        BotCommand("status", "Check server status"),
        BotCommand("setlink", "Set new link (Admin only)"),
        BotCommand("broadcast", "Broadcast message (Admin only)"),
    ])

def main():
    app = Application.builder().token(BOT_TOKEN).post_init(post_init).build()
    
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("latest", latest))
    app.add_handler(CommandHandler("status", status))
    app.add_handler(CommandHandler("setlink", setlink))
    app.add_handler(CommandHandler("broadcast", broadcast))
    app.add_handler(CommandHandler("cancel", cancel))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_admin_text))
    
    print("Bot started with Copy Button...")
    app.run_polling()

if __name__ == "__main__":
    main()
