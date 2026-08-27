# תמונה אחת שעובדת ב-Railway, Render, Fly ובכל שרת פנימי עם Docker.
FROM node:22-bookworm-slim

# better-sqlite3 מקומפל נייטיב — אלה הכלים לבנייה אם אין חבילה מוכנה לפלטפורמה
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# בסיס הנתונים חי על נפח קבוע, לא בתוך התמונה — אחרת הוא נמחק בכל פריסה
ENV AMAN_DB_PATH=/data/aman.db
ENV NODE_ENV=production
ENV PORT=3000
RUN mkdir -p /data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
