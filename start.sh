#!/bin/bash
echo "Starting Banana Web..."
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi
echo "Starting server..."
npm start