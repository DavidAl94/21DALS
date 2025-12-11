# 21DALS

## Instalación
1. Clonar el repositorio
2. Instalar dependencias:
   npm install
   npm install @azure/cosmos
   npm install express twilio uuid cosmos

3. Crear archivo .env con las variables(Para pruebas locales):
   COSMOS_ENDPOINT=...
   COSMOS_KEY=...
   COSMOS_DATABASE=21DALS_db
   COSMOS_CONTAINER=game
   TWILIO_SID=ACdda0...
   TWILIO_TOKEN=854d1d...
   TWILIO_WHATSAPP_NUMBER=+14155238886

4. Ejecutar:
   node server.js
