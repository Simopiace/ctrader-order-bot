# Usa l'immagine base di Node.js
FROM node:18

# Crea la cartella dell'app
WORKDIR /app

# Copia i file
COPY . .

# Installa le dipendenze
RUN npm install

# Espone la porta 3000 (puoi modificarla se usi una porta diversa)
EXPOSE 3000

# Comando di avvio del server
CMD ["node", "index.js"]
