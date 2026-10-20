FROM node:22-slim
WORKDIR /app
COPY . .
ENV PORT=3000 DB_PATH=/data/maison_elan.db
VOLUME /data
EXPOSE 3000
CMD ["node","--disable-warning=ExperimentalWarning","server.js"]
