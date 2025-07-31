# Usa Node 18 leggero
FROM node:18-slim

# Cartella di lavoro
WORKDIR /app

# Copia i file di pacchetto e installa solo le dipendenze di produzione
COPY package*.json ./
RUN npm install --production

# Copia il resto del codice
COPY . .

# Avvia l'app
CMD ["node", "index.js"]
