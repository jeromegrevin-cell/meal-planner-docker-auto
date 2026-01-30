FROM node:20

WORKDIR /usr/src/app

RUN apt-get update \
  && apt-get install -y python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

ENV PATH="/opt/venv/bin:${PATH}"

COPY . .

EXPOSE 3001
# Command overriden by docker-compose for dev hot reload
CMD ["node", "src/index.js"]
