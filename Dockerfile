# Image du projet « Équités préflop » : Node seul, aucune dépendance à installer.
FROM node:24-slim

WORKDIR /app
COPY index.html style.css engine.js i18n.js script.js server.js compute.js ./
COPY results ./results

# Le conteneur ne tourne pas en root
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
