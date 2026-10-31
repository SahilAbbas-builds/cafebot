<div align="center">
  <h1>☕ CafeBot</h1>
  <p><strong>AI-Powered Ordering Experience & Staff Dashboard</strong></p>

  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/Claude%20AI-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="Claude AI" />
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
</div>

<br/>

This repository contains the code for CafeBot, a web application designed to provide an AI-powered ordering experience for a café. It features a customer-facing website with a chat interface for ordering and a staff dashboard for managing orders.

## 📸 Previews

### Storefront & Menu
<img width="947" height="349" alt="Screenshot 2026-10-31 130842" src="https://github.com/user-attachments/assets/1e3658fc-b7b2-4ced-aae5-384a013cf0ba" />


### AI Order Assistant
<img src="https://github.com/user-attachments/assets/c3548251-5532-4c77-b094-db95fa15f874" height="400" />
<img src="https://github.com/user-attachments/assets/82ace911-e4c1-4144-9e33-fe87af0ef20b" height="400" />


## 🚀 Features

*   **White-labeling:** Easily customize the café's branding (name, tagline, colors, logo, hero image) through a single configuration file (`data/brand.config.json`).
*   **AI-powered Chat Assistant:** An interactive chatbot handles customer inquiries, takes orders, and manages the ordering process using a suite of defined tools.
*   **Comprehensive Ordering Tools:** The AI assistant can utilize tools for menu retrieval, adding/modifying/removing items, viewing the cart, applying promotions, setting pickup/delivery details, calculating totals, and confirming orders.
*   **Staff Dashboard:** A secure interface for staff to view incoming orders, track their status (New → Preparing → Ready → Completed), and manage order details.
*   **Order Management:** Orders are persisted and can be viewed and updated by staff through the dedicated dashboard.
*   **Responsive Design:** The frontend is designed to be accessible and user-friendly across various devices.

## 🛠️ Tech Stack

*   **Backend:** Node.js, Express.js
*   **Frontend:** HTML, CSS, JavaScript
*   **AI Integration:** Anthropic SDK (Claude Haiku 4.5)
*   **Dependencies:** dotenv, express, express-rate-limit, @anthropic-ai/sdk

## 🚀 Installation

1. Clone the repository:
```bash
git clone [https://github.com/SahilAbbas-builds/cafebot.git](https://github.com/SahilAbbas-builds/cafebot.git)
cd cafebot
