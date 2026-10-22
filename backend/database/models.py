from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, Text, ForeignKey, Float
from sqlalchemy.orm import relationship
from datetime import datetime
from database.db import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(BigInteger, unique=True, index=True, nullable=False)
    name = Column(String(100), default="USER")
    bio = Column(String(255), nullable=True)
    avatar_url = Column(Text, nullable=True)
    role = Column(String(20), default="fan")             
    access_level = Column(Integer, default=0)            
    kyc_status = Column(String(20), default="unverified") 
    legal_name = Column(String(150), nullable=True)
    is_adult = Column(Boolean, default=False)
    
    # 🛡️ Sistema de Presencia y Radar
    is_online = Column(Boolean, default=False)
    is_live_video = Column(Boolean, default=False)
    last_seen = Column(DateTime, default=datetime.utcnow)
    
    warnings_count = Column(Integer, default=0)
    referral_rewarded = Column(Boolean, default=False)
    is_disabled = Column(Boolean, default=False)
    videocall_price_alpha = Column(Integer, default=0)          

    is_creator = Column(Boolean, default=False)
    creator_tier = Column(String(30), default="none")            
    subscription_expires_at = Column(DateTime, nullable=True)     
    can_receive_tips = Column(Boolean, default=True)             
    
    created_at = Column(DateTime, default=datetime.utcnow)

class Follow(Base):
    __tablename__ = "follows"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    follower_id = Column(BigInteger, ForeignKey("users.user_id"), index=True, nullable=False)
    following_id = Column(BigInteger, ForeignKey("users.user_id"), index=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class TipMenuSlot(Base):
    __tablename__ = "tip_menu_slots"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    creator_id = Column(BigInteger, ForeignKey("users.user_id"), index=True, nullable=False)
    slot_number = Column(Integer, nullable=False)  
    title = Column(String(100), nullable=False)    
    price_alpha = Column(Integer, nullable=False)  
    is_active = Column(Boolean, default=True)

class Wallet(Base):
    __tablename__ = "wallets"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(BigInteger, unique=True, index=True, nullable=False)
    alpha_balance = Column(Integer, default=0)
    total_earned = Column(Integer, default=0)
    total_spent = Column(Integer, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    sender_id = Column(BigInteger, nullable=True)
    receiver_id = Column(BigInteger, nullable=True)
    amount = Column(Integer, nullable=False)
    tx_type = Column(String(50), nullable=False)        
    reference_id = Column(Integer, nullable=True)
    room_id = Column(String(50), nullable=True)  # Referencia opcional si la propina ocurrió en sala en vivo
    created_at = Column(DateTime, default=datetime.utcnow)

class Post(Base):
    __tablename__ = "posts"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    creator_id = Column(BigInteger, index=True, nullable=False)
    author = Column(String(100), default="mastertom")
    text_es = Column(Text, nullable=True)
    image_url = Column(Text, nullable=True)
    levelRequired = Column(Integer, default=0)
    is_ppv = Column(Boolean, default=False)
    price_alpha = Column(Integer, default=0)
    likes_count = Column(Integer, default=0)
    date_created = Column(DateTime, default=datetime.utcnow)

class UnlockedPost(Base):
    __tablename__ = "unlocked_posts"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(BigInteger, index=True, nullable=False)
    post_id = Column(Integer, index=True, nullable=False)
    unlocked_at = Column(DateTime, default=datetime.utcnow)

class Package(Base):
    __tablename__ = "packages"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    slug = Column(String(50), unique=True, index=True, nullable=False) 
    name = Column(String(100), nullable=False)
    description = Column(String(255), nullable=True)
    alpha_base = Column(Integer, nullable=False)
    bonus_percentage = Column(Integer, default=0)
    alpha_total = Column(Integer, nullable=False)
    price_stars = Column(Integer, nullable=False)
    price_ton = Column(Float, nullable=False)                    
    badge = Column(String(50), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.user_id"), index=True, nullable=False)
    recipient_id = Column(BigInteger, ForeignKey("users.user_id"), index=True, nullable=True)
    author_name = Column(String(100), nullable=False)
    author_role = Column(String(20), default="fan")  
    access_level = Column(Integer, default=0)        
    content = Column(Text, nullable=False)
    is_system = Column(Boolean, default=False)       
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class VideoCallSession(Base):
    __tablename__ = "video_call_sessions"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    fan_id = Column(BigInteger, ForeignKey("users.user_id"), index=True, nullable=False)
    creator_id = Column(BigInteger, ForeignKey("users.user_id"), index=True, nullable=False)
    cost_alpha = Column(Integer, nullable=False)
    status = Column(String(20), default="pending")  
    room_url = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

# 🎥 SALAS DE VIDEOCHAT CATEGORIZADAS (Gaming, Charlas, VIP, etc.)
class VideoRoom(Base):
    __tablename__ = "video_rooms"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    room_id = Column(String(50), unique=True, index=True, nullable=False)
    name = Column(String(100), nullable=False)
    category = Column(String(50), index=True, default="general")
    description = Column(String(255), nullable=True)
    host_id = Column(BigInteger, ForeignKey("users.user_id"), nullable=True)
    min_access_level = Column(Integer, default=0)        # Nivel mínimo para acceder como espectador
    min_broadcast_level = Column(Integer, default=1)     # Mínimo para emitir video (Nivel 0 / SPY bloqueado estrictamente)
    is_private = Column(Boolean, default=False)
    price_alpha = Column(Integer, default=0)             # Costo de entrada si la sala es de cobro inmediato
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

# 💸 SOLICITUDES DE RETIRO (CASH-OUT DE ALPHA COINS A DINERO REAL)
class PayoutRequest(Base):
    __tablename__ = "payout_requests"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.user_id"), index=True, nullable=False)
    amount_alpha = Column(Integer, nullable=False)
    amount_usd = Column(Float, nullable=False)
    payout_method = Column(String(50), nullable=False)   # 'dollarapp_ach', 'skrill', 'ton', 'binance'
    destination_account = Column(String(255), nullable=False)
    status = Column(String(20), default="pending")       # pending, approved, rejected, completed
    admin_notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    processed_at = Column(DateTime, nullable=True)