# Use a Python base image
FROM python:3.9-slim-buster

# Set the working directory
WORKDIR /app

# Copy your requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy your application code
COPY app.py .

# Expose the port your FastHTML app runs on
EXPOSE 8000

# Command to run your application
# The GOOGLE_APPLICATION_CREDENTIALS environment variable will be set when you run the container
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
