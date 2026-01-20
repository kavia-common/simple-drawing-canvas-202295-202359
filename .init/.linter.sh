#!/bin/bash
cd /home/kavia/workspace/code-generation/simple-drawing-canvas-202295-202359/drawing_app_frontend
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

